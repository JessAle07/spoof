package main

import (
    "bufio"
    "bytes"
    "errors"
    "io"
    "net"
    "net/http"
    "strings"
    "testing"
    "time"
)

type testTransport func(*http.Request) (*http.Response, error)
func (f testTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestDoHWireFormat(t *testing.T) {
    query := []byte{0x12,0x34,1,0,0,0,0,0,0,0,0,0}
    answer := append([]byte(nil),query...);answer[2]=0x81
    rt := &router{dnsMode:"doh-proxy",dohProvider:"cloudflare",timeout:time.Second}
    route := &route{raw:"test-proxy"}
    rt.dohClients.Store(route.raw,&http.Client{Transport:testTransport(func(r *http.Request)(*http.Response,error){
        if r.URL.String()!="https://cloudflare-dns.com/dns-query" || r.Method!="POST" { t.Error("unexpected DoH endpoint/method") }
        body,_:=io.ReadAll(r.Body)
        if !bytes.Equal(body,query) || r.Header.Get("Content-Type")!="application/dns-message" {t.Error("invalid DoH request")}
        return &http.Response{StatusCode:200,Header:http.Header{"Content-Type":[]string{"application/dns-message"}},Body:io.NopCloser(bytes.NewReader(answer))},nil
    })})
    got,err:=rt.exchange(route,query)
    if err!=nil || !bytes.Equal(got,answer) {t.Fatalf("response %x, error %v",got,err)}
}
func TestDoHProxyConnectOnly443(t *testing.T) {
    listener,err:=net.Listen("tcp","127.0.0.1:0");if err!=nil {t.Fatal(err)};defer listener.Close()
    target:=make(chan string,1)
    go func(){
        c,err:=listener.Accept();if err!=nil {target<-"accept failed";return};defer c.Close()
        c.SetDeadline(time.Now().Add(2*time.Second))
        req,err:=http.ReadRequest(bufio.NewReader(c));if err!=nil {target<-"request failed";return}
        target<-req.Method+" "+req.Host
        io.WriteString(c,"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
    }()
    proxy:=&route{scheme:"http",proxyAddr:listener.Addr().String(),raw:"test-connect"}
    rt:=&router{dnsMode:"doh-proxy",dohProvider:"cloudflare",timeout:time.Second}
    _,err=rt.exchange(proxy,make([]byte,12));if err==nil {t.Fatal("expected test proxy failure")}
    select {case got:=<-target:if got!="CONNECT 1.1.1.1:443" {t.Fatalf("unexpected target: %s",got)}
    case <-time.After(3*time.Second):t.Fatal("CONNECT was not received")}
}
func TestDoHDirectSkipsMappedProxy(t *testing.T) {
    rt:=&router{dnsMode:"doh-direct",dohProvider:"google",timeout:time.Second}
    expected:=errors.New("direct marker")
    rt.dohClients.Store("direct",&http.Client{Transport:testTransport(func(r *http.Request)(*http.Response,error){
        if r.URL.Host!="dns.google" {t.Error("wrong direct provider")};return nil,expected
    })})
    _,err:=rt.exchange(&route{raw:"unreachable-proxy"},make([]byte,12))
    if !errors.Is(err,expected) {t.Fatalf("direct route not selected: %v",err)}
}
func TestDoHRejectsNonDNSResponse(t *testing.T) {
    rt:=&router{dnsMode:"doh-direct",timeout:time.Second}
    rt.dohClients.Store("direct",&http.Client{Transport:testTransport(func(r *http.Request)(*http.Response,error){
        return &http.Response{StatusCode:200,Header:http.Header{"Content-Type":[]string{"text/html"}},Body:io.NopCloser(strings.NewReader("login required"))},nil
    })})
    if _,err:=rt.exchangeDoH(nil,make([]byte,12));err==nil {t.Fatal("accepted non-DNS page")}
}

// The assigned proxy is deliberately invalid: leak mode must use the host route.
func TestDNSLeakBypassesProxy(t *testing.T) {
    listener, err := net.Listen("tcp", "127.0.0.1:0")
    if err != nil { t.Fatal(err) }; defer listener.Close()
    query := []byte{0x12,0x34,1,0,0,0,0,0,0,0,0,0}
    answer := append([]byte(nil), query...); answer[2] = 0x81
    go func() {
        c, err := listener.Accept(); if err != nil { return }; defer c.Close()
        c.SetDeadline(time.Now().Add(2*time.Second))
        framed := make([]byte, 14)
        if _, err := io.ReadFull(c, framed); err != nil { return }
        c.Write(append([]byte{0,12}, answer...))
    }()
    rt := &router{dnsMode:"dns-leak", upstream:listener.Addr().String(), timeout:time.Second}
    got, err := rt.exchange(&route{scheme:"http", proxyAddr:"invalid",raw:"invalid"}, query)
    if err != nil || !bytes.Equal(got,answer) { t.Fatalf("direct DNS failed: %x %v",got,err) }
}
