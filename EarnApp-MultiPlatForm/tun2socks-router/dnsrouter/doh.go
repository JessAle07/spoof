package main

import (
    "bytes"
    "context"
    "encoding/binary"
    "errors"
    "fmt"
    "io"
    "mime"
    "net"
    "net/http"
    "strings"
    "time"
)

// HTTPS hostnames verify the provider certificate. Literal dial addresses
// prevent bootstrap DNS from using port 53 before a DoH connection exists.
func dohEndpoint(provider string) (string, string, error) {
    switch provider {
    case "", "cloudflare": return "https://cloudflare-dns.com/dns-query", "1.1.1.1:443", nil
    case "google": return "https://dns.google/dns-query", "8.8.8.8:443", nil
    default: return "", "", errors.New("unknown DoH provider")
    }
}

func (rt *router) exchangeDoH(r *route, query []byte) ([]byte, error) {
    if len(query) < 12 || len(query) > 65535 { return nil, errors.New("invalid DNS message length") }
    endpoint, target, err := dohEndpoint(rt.dohProvider)
    if err != nil { return nil, err }
    if rt.dnsMode == "doh-direct" { r = nil }
    key := "direct"
    if r != nil { key = r.raw }
    var client *http.Client
    if cached, ok := rt.dohClients.Load(key); ok { client = cached.(*http.Client) } else {
        transport := &http.Transport{
            // No ProxyFromEnvironment: use only the mapped route below.
            DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
                if r != nil {
                    c, err := r.dial(target, rt.timeout)
                    if err == nil { _ = c.SetDeadline(time.Time{}) }
                    return c, err
                }
                d := net.Dialer{Timeout: rt.timeout}
                return d.DialContext(ctx, "tcp", target)
            },
            TLSHandshakeTimeout: rt.timeout,
            ResponseHeaderTimeout: rt.timeout,
            IdleConnTimeout: 30 * rt.timeout,
            MaxIdleConnsPerHost: 2,
        }
        candidate := &http.Client{Transport: transport, Timeout: rt.timeout,
            CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
        }
        cached, loaded := rt.dohClients.LoadOrStore(key, candidate)
        if loaded { transport.CloseIdleConnections() }
        client = cached.(*http.Client)
    }
    request, err := http.NewRequest("POST", endpoint, bytes.NewReader(query))
    if err != nil { return nil, err }
    request.Header.Set("Content-Type", "application/dns-message")
    request.Header.Set("Accept", "application/dns-message")
    response, err := client.Do(request)
    if err != nil { return nil, err }
    defer response.Body.Close()
    if response.StatusCode != http.StatusOK { return nil, fmt.Errorf("DoH HTTP status %d", response.StatusCode) }
    typ, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
    if err != nil || !strings.EqualFold(typ, "application/dns-message") { return nil, errors.New("DoH returned a non-DNS content type") }
    data, err := io.ReadAll(io.LimitReader(response.Body, 65536))
    if err != nil { return nil, err }
    if len(data) < 12 || len(data) > 65535 || data[2]&0x80 == 0 || binary.BigEndian.Uint16(data[:2]) != binary.BigEndian.Uint16(query[:2]) {
        return nil, errors.New("DoH returned an invalid DNS response")
    }
    return data, nil
}
