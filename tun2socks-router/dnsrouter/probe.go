package main

// Capability probe for an upstream proxy.
//
// "Some things work, some don't" is almost always UDP, and swapping tunnel
// engines cannot fix a proxy that does not carry UDP at all. This answers the
// question directly: it performs a real SOCKS5 UDP ASSOCIATE and pushes a real
// DNS query through the returned relay, rather than trusting the handshake.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// socksStatus turns an RFC 1928 reply code into something a human can act on.
func socksStatus(code byte) string {
	switch code {
	case 1:
		return "general failure"
	case 2:
		return "not allowed by ruleset (the provider has disabled UDP for this account)"
	case 3:
		return "network unreachable"
	case 4:
		return "host unreachable"
	case 5:
		return "connection refused"
	case 6:
		return "TTL expired"
	case 7:
		return "command not supported (this proxy does not implement UDP ASSOCIATE)"
	case 8:
		return "address type not supported"
	}
	return fmt.Sprintf("unknown code 0x%02x", code)
}

type probeResult struct {
	tcpOK     bool
	tcpErr    error
	exitIP    string
	udpOK     bool
	udpErr    error
	udpDetail string
}

// udpAssociate opens a UDP relay through the proxy and returns the relay
// address to send datagrams to, plus the still-open control connection (the
// association dies when it closes).
func (r *route) udpAssociate(timeout time.Duration) (net.Conn, *net.UDPAddr, error) {
	ctrl, err := net.DialTimeout("tcp", r.proxyAddr, timeout)
	if err != nil {
		return nil, nil, err
	}
	_ = ctrl.SetDeadline(time.Now().Add(timeout))

	methods := []byte{0x00}
	if r.user != "" {
		methods = []byte{0x00, 0x02}
	}
	if _, err := ctrl.Write(append([]byte{0x05, byte(len(methods))}, methods...)); err != nil {
		ctrl.Close()
		return nil, nil, err
	}
	rep := make([]byte, 2)
	if _, err := io.ReadFull(ctrl, rep); err != nil {
		ctrl.Close()
		return nil, nil, fmt.Errorf("no reply to the SOCKS5 greeting: %w", err)
	}
	if rep[1] == 0x02 {
		if r.user == "" {
			ctrl.Close()
			return nil, nil, errors.New("proxy demands credentials, none configured")
		}
		buf := []byte{0x01, byte(len(r.user))}
		buf = append(buf, r.user...)
		buf = append(buf, byte(len(r.pass)))
		buf = append(buf, r.pass...)
		if _, err := ctrl.Write(buf); err != nil {
			ctrl.Close()
			return nil, nil, err
		}
		ack := make([]byte, 2)
		if _, err := io.ReadFull(ctrl, ack); err != nil {
			ctrl.Close()
			return nil, nil, fmt.Errorf("no reply to authentication: %w", err)
		}
		if ack[1] != 0x00 {
			ctrl.Close()
			return nil, nil, errors.New("credentials rejected")
		}
	} else if rep[1] != 0x00 {
		ctrl.Close()
		return nil, nil, fmt.Errorf("no acceptable auth method (0x%02x)", rep[1])
	}

	// UDP ASSOCIATE with a wildcard client address.
	req := []byte{0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0}
	if _, err := ctrl.Write(req); err != nil {
		ctrl.Close()
		return nil, nil, err
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(ctrl, head); err != nil {
		ctrl.Close()
		// The greeting and auth already succeeded on this same connection, so
		// silence here means the proxy ignored the UDP ASSOCIATE command
		// instead of answering it - a common way of saying "no UDP support"
		// without implementing the error code for it.
		return nil, nil, fmt.Errorf(
			"proxy accepted the connection and the credentials, then ignored "+
				"UDP ASSOCIATE entirely (%w) - it does not support UDP", err)
	}
	if head[1] != 0x00 {
		ctrl.Close()
		return nil, nil, fmt.Errorf("proxy refused UDP ASSOCIATE: %s", socksStatus(head[1]))
	}

	var host string
	switch head[3] {
	case 0x01:
		b := make([]byte, 4)
		if _, err := io.ReadFull(ctrl, b); err != nil {
			ctrl.Close()
			return nil, nil, err
		}
		host = net.IP(b).String()
	case 0x04:
		b := make([]byte, 16)
		if _, err := io.ReadFull(ctrl, b); err != nil {
			ctrl.Close()
			return nil, nil, err
		}
		host = net.IP(b).String()
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(ctrl, l); err != nil {
			ctrl.Close()
			return nil, nil, err
		}
		b := make([]byte, int(l[0]))
		if _, err := io.ReadFull(ctrl, b); err != nil {
			ctrl.Close()
			return nil, nil, err
		}
		host = string(b)
	default:
		ctrl.Close()
		return nil, nil, errors.New("unrecognised address type in UDP ASSOCIATE reply")
	}
	pb := make([]byte, 2)
	if _, err := io.ReadFull(ctrl, pb); err != nil {
		ctrl.Close()
		return nil, nil, err
	}
	port := int(binary.BigEndian.Uint16(pb))
	// Some proxies answer "success" and then hand back port 0. That is not a
	// usable relay - treat it as unsupported rather than trying to send to it.
	if port == 0 {
		ctrl.Close()
		return nil, nil, errors.New("proxy accepted UDP ASSOCIATE but returned port 0 (no real UDP relay)")
	}

	// Many proxies answer 0.0.0.0, meaning "same host you connected to".
	if host == "0.0.0.0" || host == "::" || host == "" {
		host, _, _ = net.SplitHostPort(r.proxyAddr)
	}
	relay, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		ctrl.Close()
		return nil, nil, fmt.Errorf("bad relay address %s:%d: %w", host, port, err)
	}
	return ctrl, relay, nil
}

// dnsQuery builds a minimal A query, used as a real payload for the UDP test.
func dnsQuery(name string) []byte {
	q := []byte{0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0}
	for _, label := range strings.Split(name, ".") {
		q = append(q, byte(len(label)))
		q = append(q, label...)
	}
	return append(q, 0x00, 0x00, 0x01, 0x00, 0x01)
}

// probeUDP does a full round-trip: associate, wrap a DNS query in a SOCKS5 UDP
// header, send it to the relay, and wait for a real answer.
func (r *route) probeUDP(timeout time.Duration) (bool, string, error) {
	ctrl, relay, err := r.udpAssociate(timeout)
	if err != nil {
		return false, "", err
	}
	defer ctrl.Close()

	pc, err := net.ListenPacket("udp", "0.0.0.0:0")
	if err != nil {
		return false, "", err
	}
	defer pc.Close()
	_ = pc.SetDeadline(time.Now().Add(timeout))

	// RSV(2) FRAG(1) ATYP(1) DST.ADDR DST.PORT DATA
	pkt := []byte{0x00, 0x00, 0x00, 0x01}
	pkt = append(pkt, net.ParseIP("1.1.1.1").To4()...)
	pkt = append(pkt, 0x00, 0x35)
	pkt = append(pkt, dnsQuery("example.com")...)

	if _, err := pc.WriteTo(pkt, relay); err != nil {
		return false, "", fmt.Errorf("sending to relay %s: %w", relay, err)
	}
	buf := make([]byte, 2048)
	n, _, err := pc.ReadFrom(buf)
	if err != nil {
		return false, fmt.Sprintf("associate ok (relay %s) but no datagram came back", relay),
			errors.New("UDP relay accepted the association but did not forward traffic")
	}
	if n < 10 {
		return false, "", errors.New("truncated reply from UDP relay")
	}
	return true, fmt.Sprintf("relay %s", relay), nil
}

func (r *route) probeTCP(timeout time.Duration) (string, error) {
	conn, err := r.dial("checkip.amazonaws.com:80", timeout)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	req := "GET / HTTP/1.1\r\nHost: checkip.amazonaws.com\r\nConnection: close\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		return "", err
	}
	body, err := io.ReadAll(io.LimitReader(conn, 4096))
	if err != nil && len(body) == 0 {
		return "", err
	}
	parts := strings.SplitN(string(body), "\r\n\r\n", 2)
	if len(parts) != 2 {
		return "", errors.New("malformed HTTP response through the proxy")
	}
	return strings.TrimSpace(parts[1]), nil
}

// hasINET6 reports whether the kernel will hand out an AF_INET6 socket.
//
// This is NOT a question of having IPv6 connectivity. hev-socks5-tunnel opens a
// dual-stack socket for its upstream connection even when the proxy and all
// traffic are IPv4, so the address family has to exist. A host with the ipv6
// module loaded but no IPv6 address passes this, which is the common case.
// A host booted with ipv6.disable=1 does not.
func hasINET6() bool {
	fd, err := syscall.Socket(syscall.AF_INET6, syscall.SOCK_STREAM, 0)
	if err != nil {
		return false
	}
	syscall.Close(fd)
	return true
}

func runCheckINET6() int {
	if hasINET6() {
		fmt.Println("AF_INET6 sockets available")
		return 0
	}
	fmt.Fprintln(os.Stderr, "AF_INET6 sockets unavailable (kernel booted with ipv6.disable=1, or module absent)")
	return 1
}

// runConcurrencyProbe ramps up simultaneous CONNECTs to find where a proxy
// starts refusing. Many residential and ISP proxies cap concurrent sessions,
// which shows up as bursts of connections timing out together while a single
// test connection looks perfectly healthy.
func runConcurrencyProbe(raw string, maxN int, timeout time.Duration) int {
	r, err := parseProxy(raw)
	if err != nil {
		fmt.Fprintln(os.Stderr, "probe:", err)
		return 1
	}

	fmt.Printf("Ramping concurrent CONNECTs through %s\n\n", r.proxyAddr)
	fmt.Printf("  %-8s %-10s %-10s %s\n", "TRIED", "OK", "FAILED", "SLOWEST")
	fmt.Printf("  %-8s %-10s %-10s %s\n", "-----", "--", "------", "-------")

	lastGood, firstBad := 0, 0
	for _, n := range []int{1, 2, 4, 8, 16, 32, 64, 128} {
		if n > maxN {
			break
		}
		var wg sync.WaitGroup
		results := make([]time.Duration, n)
		errs := make([]error, n)
		start := time.Now()
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				t0 := time.Now()
				// A destination that reliably accepts TLS connections.
				conn, e := r.dial("1.1.1.1:443", timeout)
				results[idx] = time.Since(t0)
				errs[idx] = e
				if e == nil {
					conn.Close()
				}
			}(i)
		}
		wg.Wait()
		_ = start

		okc, bad := 0, 0
		var slowest time.Duration
		for i := 0; i < n; i++ {
			if errs[i] == nil {
				okc++
			} else {
				bad++
			}
			if results[i] > slowest {
				slowest = results[i]
			}
		}
		status := ""
		if bad > 0 {
			if firstBad == 0 {
				firstBad = n
				status = "  <- failures start here"
			}
		} else {
			lastGood = n
		}
		fmt.Printf("  %-8d %-10d %-10d %-8s%s\n", n, okc, bad, slowest.Round(time.Millisecond), status)
		if bad > n/2 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	fmt.Println()
	if firstBad == 0 {
		fmt.Println("No concurrency limit found in the tested range.")
		fmt.Println("If clients still stall, the cause is elsewhere - try raising")
		fmt.Println("HEV_CONNECT_TIMEOUT / HEV_RW_TIMEOUT, or compare ENGINE=tun2socks.")
		return 0
	}
	fmt.Printf("This proxy handles %d concurrent connections but not %d.\n", lastGood, firstBad)
	fmt.Println("A browser or a busy app opens far more than that at once, so pages")
	fmt.Println("half-load and features time out while a single test looks fine.")
	fmt.Println("Ask the provider what the concurrent session limit is, or use fewer")
	fmt.Println("clients per proxy.")
	return 2
}

// ---------------------------------------------------------------- NAT mapping
//
// P2P apps (bandwidth sharing, game netcode, WebRTC) discover their public
// address with STUN and then expect peers to reach them on it. Whether that
// works depends on how the proxy's UDP relay allocates mappings:
//
//   endpoint-independent - one public port for all destinations. Peers can
//                          reach you. This is what "fullcone" means.
//   address-dependent    - a new port per destination. Peers cannot reach you,
//                          NAT traversal fails, and the app quietly degrades.
//
// This sends STUN binding requests to two different servers from ONE local
// socket through the relay and compares the mapped addresses it gets back.

func stunRequest() []byte {
	req := make([]byte, 20)
	binary.BigEndian.PutUint16(req[0:2], 0x0001)     // binding request
	binary.BigEndian.PutUint16(req[2:4], 0)          // length
	binary.BigEndian.PutUint32(req[4:8], 0x2112A442) // magic cookie
	for i := 8; i < 20; i++ {
		req[i] = byte(i*7 + 13) // deterministic transaction id
	}
	return req
}

// stunMapped pulls XOR-MAPPED-ADDRESS (0x0020) out of a STUN response.
func stunMapped(resp []byte) (string, error) {
	if len(resp) < 20 || binary.BigEndian.Uint16(resp[0:2]) != 0x0101 {
		return "", errors.New("not a STUN binding success response")
	}
	cookie := uint32(0x2112A442)
	n := int(binary.BigEndian.Uint16(resp[2:4]))
	body := resp[20:]
	if len(body) < n {
		n = len(body)
	}
	for off := 0; off+4 <= n; {
		typ := binary.BigEndian.Uint16(body[off : off+2])
		l := int(binary.BigEndian.Uint16(body[off+2 : off+4]))
		off += 4
		if off+l > len(body) {
			break
		}
		if typ == 0x0020 && l >= 8 {
			port := binary.BigEndian.Uint16(body[off+2:off+4]) ^ uint16(cookie>>16)
			ipRaw := binary.BigEndian.Uint32(body[off+4 : off+8])
			ip := make(net.IP, 4)
			binary.BigEndian.PutUint32(ip, ipRaw^cookie)
			return fmt.Sprintf("%s:%d", ip, port), nil
		}
		off += l
		if pad := l % 4; pad != 0 {
			off += 4 - pad
		}
	}
	return "", errors.New("no XOR-MAPPED-ADDRESS in the response")
}

func (r *route) stunVia(pc net.PacketConn, relay *net.UDPAddr, server string, timeout time.Duration) (string, error) {
	host, portStr, err := net.SplitHostPort(server)
	if err != nil {
		return "", err
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("cannot resolve %s", host)
	}
	var v4 net.IP
	for _, ip := range ips {
		if x := ip.To4(); x != nil {
			v4 = x
			break
		}
	}
	if v4 == nil {
		return "", fmt.Errorf("%s has no IPv4 address", host)
	}
	port, _ := strconv.Atoi(portStr)

	pkt := []byte{0x00, 0x00, 0x00, 0x01}
	pkt = append(pkt, v4...)
	pkt = append(pkt, byte(port>>8), byte(port))
	pkt = append(pkt, stunRequest()...)

	_ = pc.SetDeadline(time.Now().Add(timeout))
	if _, err := pc.WriteTo(pkt, relay); err != nil {
		return "", err
	}
	buf := make([]byte, 2048)
	n, _, err := pc.ReadFrom(buf)
	if err != nil {
		return "", err
	}
	if n < 10 {
		return "", errors.New("short reply from relay")
	}
	return stunMapped(buf[10:n]) // strip the SOCKS5 UDP header
}

func runNATProbe(raw string, timeout time.Duration) int {
	r, err := parseProxy(raw)
	if err != nil {
		fmt.Fprintln(os.Stderr, "probe:", err)
		return 1
	}
	ctrl, relay, err := r.udpAssociate(timeout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "udp associate failed:", err)
		return 1
	}
	defer ctrl.Close()

	pc, err := net.ListenPacket("udp", "0.0.0.0:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer pc.Close()

	servers := []string{"stun.l.google.com:19302", "stun1.l.google.com:19302"}
	seen := make([]string, 0, len(servers))
	for _, s := range servers {
		m, err := r.stunVia(pc, relay, s, timeout)
		if err != nil {
			fmt.Printf("  %-28s failed: %v\n", s, err)
			continue
		}
		fmt.Printf("  %-28s mapped to %s\n", s, m)
		seen = append(seen, m)
	}
	fmt.Println()

	if len(seen) < 2 {
		fmt.Println("Not enough STUN replies to judge the mapping.")
		fmt.Println("The relay may be dropping traffic to these servers.")
		return 1
	}
	if seen[0] == seen[1] {
		fmt.Println("Endpoint-independent mapping (fullcone-style).")
		fmt.Println("Peers can reach this client, so P2P and NAT traversal work.")
		return 0
	}
	fmt.Println("Address-dependent mapping (symmetric).")
	fmt.Println("Each destination gets a different public port, so peers cannot")
	fmt.Println("reach this client. P2P discovery, WebRTC and bandwidth-sharing")
	fmt.Println("apps will connect but never earn or transfer much.")
	fmt.Println("This is a property of the PROXY's UDP relay, not the engine.")
	return 2
}

func runProbe(raw string, timeout time.Duration) int {
	r, err := parseProxy(raw)
	if err != nil {
		fmt.Fprintln(os.Stderr, "probe:", err)
		return 1
	}

	var res probeResult
	res.exitIP, res.tcpErr = r.probeTCP(timeout)
	res.tcpOK = res.tcpErr == nil

	if r.scheme == "http" || r.scheme == "https" {
		res.udpErr = errors.New("HTTP proxies cannot carry UDP at all (no equivalent of UDP ASSOCIATE)")
	} else {
		res.udpOK, res.udpDetail, res.udpErr = r.probeUDP(timeout)
	}

	if res.tcpOK {
		fmt.Printf("tcp  ok        exit IP %s\n", res.exitIP)
	} else {
		fmt.Printf("tcp  FAILED    %v\n", res.tcpErr)
	}
	if res.udpOK {
		fmt.Printf("udp  ok        %s\n", res.udpDetail)
	} else {
		fmt.Printf("udp  NO        %v\n", res.udpErr)
		if res.udpDetail != "" {
			fmt.Printf("               %s\n", res.udpDetail)
		}
	}

	switch {
	case !res.tcpOK:
		return 1
	case !res.udpOK:
		return 2 // TCP fine, UDP unavailable
	default:
		return 0
	}
}
