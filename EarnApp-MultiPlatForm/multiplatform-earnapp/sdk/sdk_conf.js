/*jslint react:true*/
/* eslint-disable */
// LICENSE_CODE ZON
'use strict'; /*jslint node:true, es9:true, -W117*/
if (!process.env.ZNODE_DEP_SCAN)
require('./util/config.js');

const E = exports;
const cfg = {
    conf: {"ZON_VERSION":"1.651.510","CONFIG_MAKEFLAGS":"DIST=APP RELEASE=y CONFIG_WEBOS=y CONFIG_EARNAPP_CLI=y OBFUSCATE_SDK=y CONFIG_WEBOS_WRAPPER=y CONFIG_TEST_BASE=y CONFIG_TEST_NODE=y CONFIG_LINT_BASE=y CONFIG_LINT_NODE=y CONFIG_NO_TRANSCODING=y CONFIG_BATREQ=y CONFIG_BAT_CYCLE=y CONFIG_BAT_PLATFORM=app_linux64_node","CONFIG_BUILD_DATE":"21-Jul-26 18:40:24","DEFAULT_UA":"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:53.0) Gecko/20100101 Firefox/53.0","CLOUD_CONFIG_URL":"https://cdn-cloud.b-cdn.net/static/cloud_config.dat","CCGI_SSL_HOST":"clientsdk.luminati-china.io","PERR_SSL_HOST":"clientsdk.brdtnet.com","SPROXY_SSL_HOST":"clientsdk.brdtnet.com","SC_RESTORE_REMOVED":true},
    lum_zagent_ips: [],
    lum_zagent_ports: [22222],
    lum_zagent_ips_ssl: [],
    lum_zagent_ports_ssl: [80],
    lum_zagent_domains: ["l-cdn.com","l-agent.me"],
    lum_perr_domains: ["perr.l-agent.me","perr.bright-sdk.com","perr.l-err.biz"],
    lum_proxy_ips: ["15.197.193.114","3.33.193.183","54.243.132.124","54.197.238.153","23.23.115.110","23.23.176.28","34.237.189.140","34.230.120.115","54.227.144.19","34.228.163.174","35.169.231.185","35.169.76.132","35.170.3.121","34.231.146.224","35.153.6.150","34.195.75.60","3.82.75.204","52.1.158.163","3.225.88.136","52.204.186.92","34.233.61.32","3.231.12.158","54.172.44.91","98.87.238.0","44.217.232.198","18.233.89.215","52.45.186.122"],
    lum_proxy_ips_a1: ["34.230.141.83","23.21.200.81","107.20.155.97","3.225.162.142","3.84.65.241","3.93.139.27","3.93.244.66","34.197.217.233","34.199.53.229","34.200.121.251","34.205.222.157","34.206.156.144","34.207.38.111","34.235.241.233","35.168.34.151","35.169.205.0"],
    lum_proxy_domains: ["proxyjs.brdtnet.com","proxyjs.bright-sdk.com"],
    lum_proxy_domains_a1: ["p.l-conn.net"],
    lum_proxy_ports: [443,7010],
    lum_blacklisted_countries: ["IR","IQ","LB","SY","PS","KP","CU","SD"],
    lum_blocked_ips: ["127.0.0.0/8","255.255.255.255","10.0.0.0/8","172.16.0.0/12","169.254.0.0/16","192.168.0.0/16","0.0.0.0","198.18.0.0/15","100.64.0.0/10"],
    lum_test_sites: [{"ip":"3.94.40.55","url":"https://brdtest.com/myip.json","match":"(?=.*\"country\"\\s*:\\s*\"[A-Z]{2,}\")(?=.*\"asn\"\\s*:\\s*\\{.*\\})(?=.*\"geo\"\\s*:\\s*\\{.*\\})"},{"ip":"3.94.40.55","url":"https://brdtest.com/myip.json","match":"\\{\"ip_version\":4,\"country\":\"[A-Z]+\",\"asn\":\\{.+\\},\"geo\":\\{.+\\}\\}"},{"ip":"54.221.247.193","match":"http-test1","url":"http://http-test1.brdtnet.com/connection/http-test1.html"},{"ip":"104.126.37.160","match":"PNG","url":"https://www.bing.com/red-dot-24.png"},{"ip":"95.100.111.64","match":"svg","url":"https://assets.msn.com/staticsb/statics/latest/icons-wc/icons/traffic/TrafficTitle.svg"},{"ip":"23.200.189.225","match":"GIF","url":"https://support.content.office.net/en-us/media/20d0263a-6720-4ffe-8aee-a75868c3cfbf.gif"}],
    lum_test_ipv6_sites: [{"url":"https://api64.ipify.org/?format=json","match":"\\{\"ip\":\"[0-9a-f:]+\"\\}"}],
    lum_clientsdk_domains: ["clientsdk.bright-sdk.com","clientsdk.brdtnet.com","clientsdk.luminati-china.io"],
    lum_clientsdk_ips: ["3.228.36.186","3.228.177.90"],
    cloud_config_urls: ["https://cdn-cloud.b-cdn.net/static/cloud_config.dat"],
    cert_pin: {"auth_key":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/ZgMxioaBvX2rVHXkzVPg0rbpBu7WhLZMBbf5Qr7oXY=\n-----END PUBLIC KEY-----\n","pins_list":"{\"ts\":1782283035106,\"spki\":[\"oFfUjFQ0MqcGmytHtJkkF0iSjdb9CLVyr09Jimysrxk=\",\"88MboGWoPjNZGkvZ9ZZ+IiUfJFLkye5CxHH0jCrqf4k=\",\"tf9QLkwylg1ngcBPcT2Q9wt2Zl8Olv1mkK+au4gB2oI=\",\"LX0+nXiJHH9Ar7wi6bsnsSp+b9UwdEbZU/yIhTztnNE=\",\"HMGRre14gBWdMGwWaW1aN5VIG3CrciqzjzuiAVPsdiM=\"]}","signature":"bZoe2Ow3ZIVpMfuC4mHGQD4w85GAxH7xOEw4uEMQQGSaRod/nTiD1BkSD+VVF+Wje4gqRW33ib5gNrf889M5Ag=="},
};
for (const [k, v] of Object.entries(cfg))
{
    Object.defineProperty(E, k, {
        value: v,
        writable: false,
        configurable: false,
        enumerable: true
    });
}
E.sdk_conf_path = '/sdk_config_webos.json';
