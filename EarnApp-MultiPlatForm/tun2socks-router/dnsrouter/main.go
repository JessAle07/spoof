// dnsrouter - per-source-IP DNS forwarder for the tun2socks router.
//
// Each Windows container is pinned to a different upstream proxy by source IP.
// Its DNS must exit through the SAME proxy, or the name resolves in the router's
// location and you get geo-mismatched answers plus a DNS leak. This listens on
// the router's LAN address, looks up which proxy the querying container belongs
// to, and forwards the query over TCP through that proxy.
//
// Deliberately self-contained (no third-party modules) so the router image
// builds offline. The SOCKS5 client mirrors the one in ../windows/main.go.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type route struct {
	scheme    string
	proxyAddr string
	user      string
	pass      string
	raw       string
}

type router struct {
	dnsMode string
	dohProvider string
	dohClients sync.Map
	mu       sync.RWMutex
	byClient map[string]*route
	fallback *route
	// unmapped decides what happens to a client with no routes.conf entry:
	//   "direct" - resolve normally, straight out of this host (default)
	//   "refuse" - answer REFUSED
	// Default is "direct" because LAN_IF is often a shared LAN carrying
	// machines that have nothing to do with the proxies. Only use "refuse"
	// when the bridge is dedicated to proxied clients.
	unmapped string
	upstream string
	timeout  time.Duration
}

// ------------------------------------------------------------------- config

func parseProxy(raw string) (*route, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "socks5", "socks5h", "http", "https":
	default:
		return nil, fmt.Errorf("unsupported proxy scheme %q (want socks5, socks5h, http or https)", u.Scheme)
	}
	if u.Port() == "" {
		return nil, errors.New("proxy URL must include a port")
	}
	r := &route{scheme: scheme, proxyAddr: u.Host, raw: raw}
	if u.User != nil {
		r.user = u.User.Username()
		r.pass, _ = u.User.Password()
	}
	return r, nil
}

// loadRoutes reads the shared routes.conf: "<client-ip> <proxy-url>" per line.
func loadRoutes(path string) (map[string]*route, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := map[string]*route{}
	for n, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 2 {
			return nil, fmt.Errorf("%s:%d: expected '<client-ip> <proxy-url>'", path, n+1)
		}
		if net.ParseIP(f[0]) == nil {
			return nil, fmt.Errorf("%s:%d: %q is not an IP address", path, n+1, f[0])
		}
		r, err := parseProxy(f[1])
		if err != nil {
			return nil, fmt.Errorf("%s:%d: %v", path, n+1, err)
		}
		out[f[0]] = r
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: no routes defined", path)
	}
	return out, nil
}

// lookup returns the route for a client, or nil. The bool reports whether an
// unmapped client should be resolved directly rather than refused.
func (rt *router) lookup(clientIP string) (*route, bool) {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	if r, ok := rt.byClient[clientIP]; ok {
		return r, false
	}
	if rt.fallback != nil {
		return rt.fallback, false
	}
	return nil, rt.unmapped == "direct"
}

// exchangeDirect resolves without any proxy, for clients that are not ours.
// These are ordinary machines sharing the LAN; they should behave as if this
// router were not here.
func (rt *router) exchangeDirect(query []byte) ([]byte, error) {
	if rt.dnsMode == "doh-proxy" || rt.dnsMode == "doh-direct" { return rt.exchangeDoH(nil, query) }
	c, err := net.DialTimeout("tcp", rt.upstream, rt.timeout)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(rt.timeout))

	framed := make([]byte, 2+len(query))
	binary.BigEndian.PutUint16(framed[:2], uint16(len(query)))
	copy(framed[2:], query)
	if _, err := c.Write(framed); err != nil {
		return nil, err
	}
	var lenBuf [2]byte
	if _, err := io.ReadFull(c, lenBuf[:]); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint16(lenBuf[:]))
	if n == 0 || n > 65535 {
		return nil, errors.New("dns: implausible response length")
	}
	resp := make([]byte, n)
	if _, err := io.ReadFull(c, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// -------------------------------------------------------------- socks5 client

func (r *route) dial(target string, timeout time.Duration) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, err
	}

	c, err := net.DialTimeout("tcp", r.proxyAddr, timeout)
	if err != nil {
		return nil, err
	}
	_ = c.SetDeadline(time.Now().Add(timeout))

	if r.scheme == "http" || r.scheme == "https" {
		err = r.httpConnect(c, host, port)
	} else {
		err = r.handshake(c, host, port)
	}
	if err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// httpConnect tunnels via an HTTP proxy, for providers that offer no SOCKS5.
func (r *route) httpConnect(c net.Conn, host string, port int) error {
	target := net.JoinHostPort(host, strconv.Itoa(port))
	req := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n"
	if r.user != "" {
		cred := base64.StdEncoding.EncodeToString([]byte(r.user + ":" + r.pass))
		req += "Proxy-Authorization: Basic " + cred + "\r\n"
	}
	req += "\r\n"
	if _, err := c.Write([]byte(req)); err != nil {
		return err
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: "CONNECT"})
	if err != nil {
		return fmt.Errorf("http connect: %w", err)
	}
	// Successful CONNECT transfers this socket to the TLS/DNS tunnel.
	// Do not drain or close its response body before using the socket.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http connect: proxy returned %s", resp.Status)
	}
	if br.Buffered() > 0 {
		return errors.New("http connect: proxy sent data before the tunnel opened")
	}
	return nil
}

func (r *route) handshake(c net.Conn, host string, port int) error {
	methods := []byte{0x00}
	if r.user != "" {
		methods = []byte{0x00, 0x02}
	}
	if _, err := c.Write(append([]byte{0x05, byte(len(methods))}, methods...)); err != nil {
		return err
	}
	rep := make([]byte, 2)
	if _, err := io.ReadFull(c, rep); err != nil {
		return err
	}
	if rep[0] != 0x05 {
		return errors.New("socks5: bad version from proxy")
	}
	switch rep[1] {
	case 0x00:
	case 0x02:
		if r.user == "" {
			return errors.New("socks5: proxy wants credentials, none configured")
		}
		buf := []byte{0x01, byte(len(r.user))}
		buf = append(buf, r.user...)
		buf = append(buf, byte(len(r.pass)))
		buf = append(buf, r.pass...)
		if _, err := c.Write(buf); err != nil {
			return err
		}
		ack := make([]byte, 2)
		if _, err := io.ReadFull(c, ack); err != nil {
			return err
		}
		if ack[1] != 0x00 {
			return errors.New("socks5: credentials rejected")
		}
	default:
		return fmt.Errorf("socks5: no acceptable auth method (0x%02x)", rep[1])
	}

	req := []byte{0x05, 0x01, 0x00}
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			req = append(append(req, 0x01), v4...)
		} else {
			req = append(append(req, 0x04), ip.To16()...)
		}
	} else {
		if len(host) > 255 {
			return errors.New("socks5: hostname too long")
		}
		req = append(append(req, 0x03, byte(len(host))), host...)
	}
	var p [2]byte
	binary.BigEndian.PutUint16(p[:], uint16(port))
	req = append(req, p[:]...)
	if _, err := c.Write(req); err != nil {
		return err
	}

	head := make([]byte, 4)
	if _, err := io.ReadFull(c, head); err != nil {
		return err
	}
	if head[1] != 0x00 {
		return fmt.Errorf("socks5: connect refused (code 0x%02x)", head[1])
	}
	switch head[3] {
	case 0x01:
		_, err := io.ReadFull(c, make([]byte, 6))
		return err
	case 0x04:
		_, err := io.ReadFull(c, make([]byte, 18))
		return err
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(c, l); err != nil {
			return err
		}
		_, err := io.ReadFull(c, make([]byte, int(l[0])+2))
		return err
	}
	return errors.New("socks5: unknown address type in reply")
}

// ------------------------------------------------------------------ DNS bits

// exchange forwards one query over a TCP connection (RFC 1035 length prefix).
func (rt *router) exchange(r *route, query []byte) ([]byte, error) {
	if rt.dnsMode == "dns-leak" { return rt.exchangeDirect(query) }
	if rt.dnsMode == "doh-proxy" || rt.dnsMode == "doh-direct" { return rt.exchangeDoH(r, query) }
	c, err := r.dial(rt.upstream, rt.timeout)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(rt.timeout))

	framed := make([]byte, 2+len(query))
	binary.BigEndian.PutUint16(framed[:2], uint16(len(query)))
	copy(framed[2:], query)
	if _, err := c.Write(framed); err != nil {
		return nil, err
	}

	var lenBuf [2]byte
	if _, err := io.ReadFull(c, lenBuf[:]); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint16(lenBuf[:]))
	if n == 0 || n > 65535 {
		return nil, errors.New("dns: implausible response length")
	}
	resp := make([]byte, n)
	if _, err := io.ReadFull(c, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

func skipName(msg []byte, off int) (int, bool) {
	for {
		if off >= len(msg) {
			return 0, false
		}
		l := int(msg[off])
		if l == 0 {
			return off + 1, true
		}
		if l&0xC0 == 0xC0 { // compression pointer
			return off + 2, true
		}
		off += l + 1
	}
}

func skipRR(msg []byte, off int) (int, bool) {
	off, ok := skipName(msg, off)
	if !ok || off+10 > len(msg) {
		return 0, false
	}
	rdlen := int(binary.BigEndian.Uint16(msg[off+8 : off+10]))
	off += 10 + rdlen
	if off > len(msg) {
		return 0, false
	}
	return off, true
}

// maxUDPSize honours the EDNS0 buffer size the client advertised, so we only
// truncate when we genuinely have to.
func maxUDPSize(query []byte) int {
	const bare = 512
	if len(query) < 12 {
		return bare
	}
	arcount := int(binary.BigEndian.Uint16(query[10:12]))
	if arcount == 0 {
		return bare
	}
	off := 12
	for i := 0; i < int(binary.BigEndian.Uint16(query[4:6])); i++ {
		n, ok := skipName(query, off)
		if !ok || n+4 > len(query) {
			return bare
		}
		off = n + 4
	}
	skip := int(binary.BigEndian.Uint16(query[6:8])) + int(binary.BigEndian.Uint16(query[8:10]))
	for i := 0; i < skip; i++ {
		n, ok := skipRR(query, off)
		if !ok {
			return bare
		}
		off = n
	}
	for i := 0; i < arcount; i++ {
		if off < len(query) && query[off] == 0x00 && off+5 <= len(query) {
			if binary.BigEndian.Uint16(query[off+1:off+3]) == 41 { // OPT
				size := int(binary.BigEndian.Uint16(query[off+3 : off+5]))
				switch {
				case size < bare:
					return bare
				case size > 4096:
					return 4096
				default:
					return size
				}
			}
		}
		n, ok := skipRR(query, off)
		if !ok {
			return bare
		}
		off = n
	}
	return bare
}

// truncate returns a header-only reply with TC set, telling the client to retry
// over TCP rather than silently dropping data.
func truncate(query, resp []byte) []byte {
	if len(resp) < 12 {
		return resp
	}
	out := make([]byte, 12)
	copy(out, resp[:12])
	out[2] |= 0x02 // TC
	binary.BigEndian.PutUint16(out[6:8], 0)
	binary.BigEndian.PutUint16(out[8:10], 0)
	binary.BigEndian.PutUint16(out[10:12], 0)
	if len(query) > 12 {
		if end, ok := skipName(query, 12); ok && end+4 <= len(query) {
			out = append(out, query[12:end+4]...)
			binary.BigEndian.PutUint16(out[4:6], 1)
			return out
		}
	}
	binary.BigEndian.PutUint16(out[4:6], 0)
	return out
}

func refuse(query []byte) []byte {
	if len(query) < 12 {
		return nil
	}
	out := make([]byte, 12)
	copy(out, query[:12])
	out[2] |= 0x80 // QR
	out[3] = (out[3] & 0xF0) | 0x05
	binary.BigEndian.PutUint16(out[6:8], 0)
	binary.BigEndian.PutUint16(out[8:10], 0)
	binary.BigEndian.PutUint16(out[10:12], 0)
	return out
}

// ------------------------------------------------------------------- servers

func (rt *router) serveUDP(pc net.PacketConn) error {
	buf := make([]byte, 4096)
	for {
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return err
		}
		query := make([]byte, n)
		copy(query, buf[:n])
		go func(q []byte, a net.Addr) {
			clientIP, _, _ := net.SplitHostPort(a.String())
			r, direct := rt.lookup(clientIP)

			var resp []byte
			var err error
			switch {
			case r != nil:
				resp, err = rt.exchange(r, q)
				if err != nil {
					log.Printf("udp %s via %s: %v", clientIP, r.proxyAddr, err)
					return
				}
			case direct:
				resp, err = rt.exchangeDirect(q)
				if err != nil {
					log.Printf("udp %s direct: %v", clientIP, err)
					return
				}
			default:
				log.Printf("udp %s: not in routes.conf, refusing", clientIP)
				if reply := refuse(q); reply != nil {
					pc.WriteTo(reply, a)
				}
				return
			}
			if len(resp) > maxUDPSize(q) {
				resp = truncate(q, resp)
			}
			pc.WriteTo(resp, a)
		}(query, addr)
	}
}

func (rt *router) serveTCP(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go func(conn net.Conn) {
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(rt.timeout + 5*time.Second))
			clientIP, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
			r, direct := rt.lookup(clientIP)

			var lenBuf [2]byte
			for {
				if _, err := io.ReadFull(conn, lenBuf[:]); err != nil {
					return
				}
				q := make([]byte, binary.BigEndian.Uint16(lenBuf[:]))
				if _, err := io.ReadFull(conn, q); err != nil {
					return
				}
				var resp []byte
				switch {
				case r != nil:
					if resp, err = rt.exchange(r, q); err != nil {
						log.Printf("tcp %s via %s: %v", clientIP, r.proxyAddr, err)
						return
					}
				case direct:
					if resp, err = rt.exchangeDirect(q); err != nil {
						log.Printf("tcp %s direct: %v", clientIP, err)
						return
					}
				default:
					resp = refuse(q)
				}
				out := make([]byte, 2+len(resp))
				binary.BigEndian.PutUint16(out[:2], uint16(len(resp)))
				copy(out[2:], resp)
				if _, err := conn.Write(out); err != nil {
					return
				}
				_ = conn.SetDeadline(time.Now().Add(rt.timeout + 5*time.Second))
			}
		}(c)
	}
}

func main() {
	dnsMode := flag.String("dns-mode", "proxy", "DNS: dns-leak (direct host TCP 53), proxy (TCP 53), doh-proxy (HTTPS 443 through assigned proxy), doh-direct (HTTPS 443 direct)")
	dohProvider := flag.String("doh-provider", "cloudflare", "DoH resolver: cloudflare | google")
	listen := flag.String("listen", "0.0.0.0:53", "address to serve DNS on")
	routesPath := flag.String("routes", "/etc/tun2socks/routes.conf", "client-ip to proxy map")
	upstream := flag.String("upstream", "1.1.1.1:53", "resolver reached through each proxy")
	fallback := flag.String("fallback", "", "proxy URL for clients absent from the map")
	unmapped := flag.String("unmapped", "direct", "clients absent from the map: direct | refuse")
	timeout := flag.Duration("timeout", 10*time.Second, "per-query timeout")
	probe := flag.String("probe", "", "test one proxy URL for TCP and UDP support, then exit")
	checkINET6 := flag.Bool("check-inet6", false, "report whether AF_INET6 sockets can be created, then exit")
	probeConn := flag.Int("probe-concurrency", 0, "with -probe, ramp up to N simultaneous connections")
	natProbe := flag.Bool("probe-nat", false, "with -probe, report the UDP relay's NAT mapping behaviour")
	flag.Parse()

	if *natProbe && *probe != "" {
		os.Exit(runNATProbe(*probe, 15*time.Second))
	}

	if *probeConn > 0 && *probe != "" {
		os.Exit(runConcurrencyProbe(*probe, *probeConn, 15*time.Second))
	}

	if *checkINET6 {
		os.Exit(runCheckINET6())
	}

	// Capability probe: exits 0 = TCP+UDP, 2 = TCP only, 1 = broken.
	if *probe != "" {
		os.Exit(runProbe(*probe, 15*time.Second))
	}

	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix("[dnsrouter] ")

	routes, err := loadRoutes(*routesPath)
	if err != nil {
		log.Fatalf("FATAL: %v", err)
	}
	switch *unmapped {
	case "direct", "refuse":
	default:
		log.Fatalf("FATAL: -unmapped must be 'direct' or 'refuse', got %q", *unmapped)
	}
	if *dnsMode != "dns-leak" && *dnsMode != "proxy" && *dnsMode != "doh-proxy" && *dnsMode != "doh-direct" { log.Fatal("invalid DNS mode") }
	if _, _, err := dohEndpoint(*dohProvider); err != nil { log.Fatal(err) }
	log.Printf("DNS transport: %s; DoH provider: %s", *dnsMode, *dohProvider)
	rt := &router{dnsMode: *dnsMode, dohProvider: *dohProvider, byClient: routes, upstream: *upstream, timeout: *timeout, unmapped: *unmapped}
	if *fallback != "" {
		if rt.fallback, err = parseProxy(*fallback); err != nil {
			log.Fatalf("FATAL: bad --fallback: %v", err)
		}
	}

	pc, err := net.ListenPacket("udp", *listen)
	if err != nil {
		log.Fatalf("FATAL: udp bind %s: %v", *listen, err)
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("FATAL: tcp bind %s: %v", *listen, err)
	}

	if *unmapped == "direct" {
		log.Printf("serving DNS on %s for %d pinned clients, upstream %s "+
			"(other LAN clients resolved normally)", *listen, len(routes), *upstream)
	} else {
		log.Printf("serving DNS on %s for %d pinned clients, upstream %s "+
			"(other LAN clients REFUSED)", *listen, len(routes), *upstream)
	}
	for ip, r := range routes {
		log.Printf("  %-15s -> %s", ip, r.proxyAddr)
	}

	errCh := make(chan error, 2)
	go func() { errCh <- rt.serveUDP(pc) }()
	go func() { errCh <- rt.serveTCP(ln) }()
	log.Fatalf("FATAL: listener stopped: %v", <-errCh)
}
