// LICENSE_CODE ZON
'use strict'; /*jslint node:true, es9:true*/
require('./util/config.js');
const os = require('os');
const zlib = require('zlib');
const {URL} = require('url');
const fs = require('fs');
const dns = require('dns');
const events = require('events');
const net = require('net');
const https = require('https');
const uuid_gen = require('uuid');
const netmask = require('netmask');
const lri = require('linux-release-info');
const v8 = (function(){
    try { return require('v8'); } catch(e){ return; }
})();
if (!process.env.WS_NO_ZCOUNTER) // zcounter must not used on peer side
    throw new Error('must run with WS_NO_ZCOUNTER=1');
const zon_config = require('./zon_config.json');
const {
    tunnel_util,
    rand_uniform,
    zurl,
    zutil,
    date,
    sprintf,
    file,
    zerr,
    zws,
    http_capsule,
    udp_stream,
    util,
    alias,
} = require('./_modules.js');
const log = require('./log.js');
const web_request = require('./web_request.js');
const cert_pin = require('./cert_pin.js');
const perr = require('./perr.js');
const sdk_conf = require('./sdk_conf.js');
const cloud_conf = require('./cloud_conf.js');
const {Task} = require('./util/task.js');
/* eslint-disable */
const ws = require('ws'); // require for dep scan
/* eslint-enable */
const {Udp_unwrap, Udp_encapsulate} = http_capsule;
const {Stream_udp} = udp_stream;
const sleep = ms=>new Promise(r=>setTimeout(r, ms));
const {ver_conf, get_rand_elm} = util;
const reported_version = ()=>ver_conf.reported_version || zon_config.ZON_VERSION;
const E = exports;
const ms = date.ms;
const env = process.env;
let monitor_et, idle_monitor_et;
let idle = true;
let blocked_ip = [];
let is_1b_perr_sent;
let user_settings;
let uuid;
let started = false;
let vpn_profile_enabled = false;

if (!env.ZLXC)
    dns.setServers(['8.8.8.8', '8.8.4.4']);

const init_std = ()=>{
    const log_stream = log
        .get_logger(`${ver_conf.confdir}/${ver_conf.log_file}`,
        ver_conf.debug);
    const stderr_write = process.stderr.write;
    process.stderr.write = function(){
        if (ver_conf.debug)
            stderr_write.apply(process.stderr, arguments);
        log_stream.log(arguments[0]);
    };
    const stdout_write = process.stdout.write;
    process.stdout.write = function(){
        if (ver_conf.debug)
            stdout_write.apply(process.stdout, arguments);
        log_stream.log(arguments[0]);
    };
};

const global_opt = {
    agent_ping: false,
    agent_ping_interval: 10*ms.MIN,
    agent_ping_timeout: ms.MIN,
    proxy_ping_interval: 10*ms.MIN,
    proxy_ping_timeout: ms.MIN,
    proxy_retry_interval: 10*ms.SEC,
    proxy_retry_max: 30*ms.MIN,
    proxy_handshake_timeout: 10*ms.SEC,
};

const {ip_in_cidrs, is_ipv6_target_allowed,
    milestones, calc_cpu_usage} = tunnel_util;
// explicitly cast cidrs to strings for the correct search
const ip_in_list = (list, ip)=>ip_in_cidrs(list.map(r=>''+r), ip);
const validate_ipv6_target = (target, dev)=>
    is_ipv6_target_allowed(target, dev && dev.addr || '',
        dev && dev.netmask_v6 || '');
const set_blocked_ip = _blocked_ip=>{
    blocked_ip = _blocked_ip.map(ip=>new netmask.Netmask(ip));
    return blocked_ip;
};
const resolve_addr = async(domain, resolve_type)=>{
    const method = resolve_type||'resolve4';
    const res = await dns.promises[method](domain);
    switch (resolve_type)
    {
    case 'resolve4':
    case 'resolve6':
        return res;
    default:
        return res.map(ip=>({address: ip, family: 4}));
    }
};

const cmd_dns = async msg=>{
    if (!msg.domain)
        return;
    zerr.notice('cmd_dns '+msg.domain);
    let ret = {};
    try {
        ret.res = await resolve_addr(msg.domain, msg.resolve_type);
    } catch(e){
        ret.err = `DNS failed: ${e}`;
    }
    if (msg.get_servers)
        ret.servers = dns.getServers();
    return ret;
};

const choose_local_addr = (msg, conn, ipv6)=>{
    if (!msg || msg.skip_local_addr)
        return;
    if (msg.local_addr)
        return msg.local_addr;
    if (!conn)
        return;
    let local_addr = ipv6 ? conn.addr_ipv6 : conn.local_addr;
    if (msg.ifname)
    {
        const netif = E.devs.find(i=>i.name==msg.ifname)||{};
        const addr = ipv6 ? netif.addr_ipv6 : netif.addr;
        if (!addr)
            zerr('not found addr for '+msg.ifname);
        local_addr = addr||local_addr;
    }
    return local_addr;
};

let sockets = [];
const untrack_socket = sock=>sockets = sockets.filter(s=>s!=sock);
const track_open_socket = (sock, udp)=>{
    sockets.push(sock);
    sock.on('close', ()=>{
        untrack_socket(sock);
    });
    sock.on('error', e=>{
        untrack_socket(sock);
    });
    if (!udp)
    {
        sock.setTimeout(1*ms.MIN);
        sock.on('timeout', ()=>{
            sock.destroy();
        });
    }
};

let last_vfd = 1;
const cmd_tun = async(msg, conn)=>{
    zerr.notice('cmd_tun: %s', JSON.stringify(msg));
    if (!msg.host || !msg.port)
        return;
    if (+msg.port==25)
        return {err: `Blocked port ${msg.port}`};
    zerr.perr('21_svc_tun_start', {}, {funnel: true, sdk: true});
    zerr.perr('tun_start', {}, {once: true});
    let timeline = [], timeline_reported = 0;
    let dn_bytes = 0, up_bytes = 0, milestones_reached = 0;
    let log_timeline = ev=>timeline.push({ev, ts: date.monotonic()});
    let report_timeline = ()=>{
        if (timeline.length<=timeline_reported)
            return;
        let res = timeline.slice(timeline_reported);
        timeline_reported = timeline.length;
        return res;
    };
    zerr.notice(`cmd_tun ${msg.host}:${msg.port} ${msg.debug||''}`);
    const open = (vfd, stream_opt)=>{
        let stream = conn.mux.open(vfd, undefined, stream_opt);
        stream.on('error', err=>{
            if (err.message=='1006')
                zerr('ws_stream '+vfd+' unexpected close');
            else
                zerr('ws_stream '+vfd+' err '+zerr.e2s(err));
        });
        return stream;
    };
    let vfd, stream;
    if (msg.vfd)
    {
        vfd = msg.vfd;
        if (last_vfd<vfd)
            last_vfd = vfd;
        stream = open(vfd, msg.stream_opt);
    }
    log_timeline('init');
    let host = msg.host;
    let is_ipv6 = net.isIPv6(host);
    zerr.notice('host: %s, ipv6: %s', host, is_ipv6);
    if (!net.isIPv4(host) && !is_ipv6)
    {
        let addr;
        try {
            zerr.notice('DNS %s [resolve_type=%s]',
                host, msg.resolve_type||'N\\A');
            addr = await resolve_addr(host, msg.resolve_type);
            zerr.notice('DNS %s -> %s [resolve_type=%s]',
                host, addr, msg.resolve_type||'N\\A');
            log_timeline('dns');
            if (!addr || !addr.length)
            {
                if (vfd)
                    conn.mux.close(vfd);
                return {err: 'DNS failed: no results'};
            }
            addr = rand_uniform.rand_subset(addr, addr.length);
            host = addr[0] && addr[0].address ? addr[0].address : addr[0];
            is_ipv6 = addr[0] && addr[0].family == 'IPv6'
                || msg.resolve_type=='resolve6';
        } catch(e){
            zerr(`resolve_err: ${e}`);
            if (vfd)
                conn.mux.close(vfd);
            return {err: `DNS failed: ${e}`};
        }
    }
    if (!is_ipv6 && ip_in_list(blocked_ip, host)
        || is_ipv6 && !validate_ipv6_target(host, conn.device_info))
    {
        zerr(`TUN req blocked IP ${host}`);
        return {err: `Blocked IP ${host}`};
    }
    let w_resolve, w_reject;
    const w = new Promise((res, rej)=>{ w_resolve = res; w_reject = rej; });
    let sock_opt = {port: msg.port, host};
    let local_addr = choose_local_addr(msg, conn, is_ipv6);
    zerr.notice('local_addr: %s', local_addr);
    if (local_addr)
        sock_opt.localAddress = local_addr;
    let sock;
    let udp = msg.transport=='udp';
    if (udp)
    {
        sock = new Stream_udp(Object.assign({}, sock_opt, {
            sock_type: is_ipv6 ? 'udp6' : 'udp4',
        }), ()=>w_resolve());
        stream.pipe(
            new Udp_unwrap()
        ).pipe(sock).pipe(
            new Udp_encapsulate()
        ).pipe(stream);
    }
    else
    {
        sock = net.createConnection(sock_opt);
        sock.on('connect', ()=>w_resolve());
        sock.setNoDelay();
        stream.pipe(sock).pipe(stream);
    }
    sock.on('error', e=>w_reject(e));
    try {
        await w;
        if (is_ipv6)
            zerr.perr('ipv6_05_connect_success', msg, {once: true});
        if (udp)
            zerr.perr('udp_05_connect_success', msg, {once: true});
        if (is_ipv6 && udp)
            zerr.perr('udp_ipv6_05_connect_success', msg, {once: true});
    } catch(e){
        if (is_ipv6)
        {
            zerr.perr('ipv6_06_connect_fail', {err: zerr.e2s(e)},
                {once: true});
        }
        if (udp)
        {
            zerr.perr('udp_06_connect_fail', {err: zerr.e2s(e)},
                {once: true});
        }
        if (is_ipv6 && udp)
        {
            zerr.perr('udp_ipv6_06_connect_fail', {err: zerr.e2s(e)},
                {once: true});
        }
        if (vfd)
            conn.mux.close(vfd);
        return {err: `Connection failed: ${e}`};
    }
    log_timeline('connect');
    track_open_socket(sock, udp);
    if (!vfd)
    {
        vfd = ++last_vfd;
        stream = open(vfd, msg.stream_opt);
    }
    let check_milestones = (dn, up)=>{
        if (!is_1b_perr_sent)
        {
            zerr.perr('22_svc_tun_1b', {}, {funnel: true, sdk: true});
            zerr.perr('tun_1b', {}, {once: true});
            if (is_ipv6)
                zerr.perr('ipv6_07_tun_1b', {}, {once: true});
            if (udp)
                zerr.perr('udp_07_tun_1b', {}, {once: true});
            if (is_ipv6 && udp)
                zerr.perr('udp_ipv6_07_tun_1b', {}, {once: true});
            is_1b_perr_sent = true;
        }
        dn_bytes += dn;
        up_bytes += up;
        if (!dn_bytes && up_bytes && up_bytes==up)
            log_timeline('up_1b');
        while (milestones_reached<milestones.length)
        {
            let milestone = milestones[milestones_reached];
            if (dn_bytes<milestone)
                return;
            milestones_reached++;
            log_timeline(milestone<1000
                ? `dn_${milestone}b` : `dn_${milestone/1000|0}kb`);
        }
        // all milestones reached
        const rep_timeline = report_timeline();
        if (rep_timeline)
            conn.ipc.tun_report({vfd, timeline: rep_timeline});
    };
    stream.on('error', err=>{
        if (is_ipv6)
            zerr.perr('ipv6_08_tun_err', {err: zerr.e2s(err)}, {once: true});
        if (udp)
            zerr.perr('udp_08_tun_err', {err: zerr.e2s(err)}, {once: true});
        if (is_ipv6 && udp)
        {
            zerr.perr('udp_ipv6_08_tun_err', {err: zerr.e2s(err)},
                {once: true});
        }
        try {
            sock.destroy();
        } catch(e){
            zerr('sock destroy fail');
            if (is_ipv6)
            {
                zerr.perr('ipv6_10_socket_destroy_fail', {err: zerr.e2s(e)},
                    {once: true});
            }
            if (udp)
            {
                zerr.perr('udp_10_socket_destroy_fail', {err: zerr.e2s(e)},
                    {once: true});
            }
            if (is_ipv6 && udp)
            {
                zerr.perr('udp_ipv6_10_socket_destroy_fail',
                    {err: zerr.e2s(e)}, {once: true});
            }
        }
    });
    sock.on('close', ()=>{
        // XXX vladimir: get rid of double close and tun_destroy resp
        try {
            stream.emit('_close');
        } catch(e){
            zerr('ws_stream on sock close err '+zerr.e2s(e));
        }
        conn.ipc.tun_destroy({vfd, timeline: report_timeline()});
    });
    sock.on('data', chunk=>{
        check_milestones(chunk.length, 0);
    });
    stream.on('data', chunk=>{
        check_milestones(0, chunk.length);
    });
    timeline_reported = timeline.length;
    return {vfd, timeline, sock_opt};
};

const cmd_tun_close = (msg, conn)=>{
    zerr.notice(`cmd_tun_close ${msg.vfd} ${msg.debug||''}`);
    let vfd = +msg.vfd;
    if (!vfd)
        return;
    conn.mux.close(vfd);
    return {};
};

const get_cpu_times = ()=>{
    const cpus = os.cpus();
    return cpus.map(cpu=>cpu.times);
};

const idle_state = {};
let prev_cpu_times = get_cpu_times();
const get_idle_state = ()=>{
    const round_2 = n=>Math.ceil(n*100)/100;
    const percent = (f, t)=>100*f/t;
    const now = new Date();
    const curr = get_cpu_times();
    const usage = calc_cpu_usage(curr, prev_cpu_times);
    idle_state.cpu_usage = round_2(usage*100);
    idle_state.cpu_usage_ts = +now;
    prev_cpu_times = curr;
    idle_state.mem_usage = round_2(100-percent(os.freemem(), os.totalmem()));
    idle_state.mem_usage_ts = +now;
    idle_state.num_streams = sockets.length;
    idle_state.num_streams_ts = +now;
    if (v8)
    {
        const heap = v8.getHeapStatistics();
        idle_state.heap_size = heap.total_heap_size;
        idle_state.heap_size_ts = +now;
        // heap usage is precentage of the total used system memory
        idle_state.heap_usage = round_2(percent(
            heap.total_heap_size, os.totalmem()-os.freemem()));
        idle_state.heap_usage_ts = +now;
    }
};

const idle_state_monitor = ()=>{
    let running = true;
    (async()=>{
        const max_dur = 20*ms.SEC;
        // eslint-disable-next-line no-unmodified-loop-condition
        while (running)
        {
            const now = Date.now();
            zerr.notice('idle_state_monitor run');
            try {
                get_idle_state();
            } catch(e){
                zerr.perr('idle_get_exeption', {err: zerr.e2s(e)});
            }
            const after = Date.now();
            if (after-now>max_dur)
            {
                zerr.perr('idle_get_too_long', {
                    time: after-now,
                    state: idle_state_monitor,
                });
            }
            await sleep(60*ms.SEC);
        }
    })();
    return {return: ()=>{ running = false; }};
};

const status_get = msg=>{
    const res = {
        idle,
        usage: {},
        idle_state,
        bw: {},
        vpn_profile_enabled: is_vpn_profile_enabled(),
    };
    zerr.notice('status_get: %O', res);
    return res;
};

const client_connected = async client=>{
    let disconnect = false;
    try {
        await new Promise(resolve=>{
            client.on('disconnected', ()=>{
                disconnect = true;
                resolve();
            });
        });
    } finally {
        if (!disconnect)
            client.close();
    }
};

const get_connect_fallback_suffix = retry_num=>retry_num
    ? `_a${retry_num}` : '';

const _client_connect = async(opt={}, retry_num=0, retry_fn=0)=>{
    let canceled = true, connected = false;
    const {host, port, servername, session, local_addr, addr_ipv6, cid} = opt;
    const agent = new https.Agent({
        servername,
        session,
        localAddress: local_addr,
        ca: util.get_root_ca(),
    });
    zerr.notice('client_connect start [%s]->%s:%s (%s)', local_addr, host,
        port, servername);
    const suffix = get_connect_fallback_suffix(retry_num);
    let client = new zws.Client(`wss://${host}:${port}`, {
        label: 'agent', agent, mux: true,
        ipc_server: {
            dns(msg){
                return cmd_dns(msg, this);
            },
            tun(msg){
                return cmd_tun(msg, this);
            },
            tun_close(msg){
                return cmd_tun_close(msg, this);
            },
            tunnel_init(msg){
                return tunnel_init(msg, this, cid,
                    ['zagent', servername].join('_'));
            },
            status_get(msg){
                return status_get(msg);
            },
        },
        ipc_client: {tun_report: 'post', tun_destroy: 'post'},
        ipc_zjson: true,
        ping: global_opt.agent_ping,
        ping_interval: global_opt.agent_ping_interval,
        ping_timeout: global_opt.agent_ping_timeout,
    });
    client.device_info = opt.device_info;
    client.addr_ipv6 = addr_ipv6;
    let resolve, reject;
    const p = new Promise((res, rej)=>{ resolve = res; reject = rej; });
    client.on('connected', ()=>{
        canceled = false;
        connected = true;
        client_connected(client);
        resolve();
        zerr.perr(`tun_init_success${suffix}`, {servername}, {once: true});
    });
    client.on('disconnected', ()=>{
        canceled = false;
        reject(new Error(client.reason || 'connection failed'));
        client.close();
        if (connected)
        {
            connected = false;
            return;
        }
        zerr.perr(`tun_init_err${suffix}`, {error: client.reason},
            {once: true});
        if (retry_fn)
        {
            zerr.notice('client_connect fallback: %s', retry_num+1);
            retry_fn();
        }
    });
    try {
        await p;
    } finally {
        if (canceled)
        {
            client.close(-2, 'shutdown');
            agent.destroy();
        }
    }
    zerr.notice('client_connect established [%s]->%s:%s (%s)', local_addr,
        host, port, servername);
};

const get_client_connect_fallback = (retry_num, msg, opt)=>{
    if (retry_num>=10)
        return;
    const suffix = get_connect_fallback_suffix(retry_num);
    if (!msg[`host${suffix}`] && !msg[`port${suffix}`]
        && !msg[`servername${suffix}`])
    {
        return;
    }
    // XXX vladislavs: use sdk_conf
    const opt_servername = zutil.get(opt, 'servername',
        'client.brdtnet.com');
    const _opt = Object.assign({}, opt, {
        host: zutil.get(msg, `host${suffix}`, opt.host),
        port: zutil.get(msg, `port${suffix}`, opt.port),
        servername: zutil.get(msg, `servername${suffix}`, opt_servername),
    });
    return ()=>_client_connect(_opt, retry_num,
        get_client_connect_fallback(retry_num+1, msg, _opt));
};

const client_connect = async(msg, conn, cid)=>{
    zerr.perr('21_svc_tun_ready', {}, {funnel: true, sdk: true});
    zerr.perr('tun_ready', {}, {once: true});
    if (!msg.port || !msg.host)
        return;
    const opt = {
        host: msg.host,
        port: msg.port,
        servername: msg.servername,
        session: msg.session ? Buffer.from(msg.session, 'base64') : null,
        cid,
        local_addr: choose_local_addr(msg, conn),
        addr_ipv6: conn.addr_ipv6,
        device_info: conn.device_info,
    };
    await _client_connect(opt, 0, get_client_connect_fallback(1, msg, opt));
};

const ip_type = (ip, ifs)=>{
    if (!ip || !ifs)
        return;
    const dev = ifs.find(i=>i.addr==ip);
    if (!dev)
        return zerr.warn(`interface not found for ${ip}`);
    zerr.notice(`detected interface ${dev.name} for ${ip}`);
    return {name: dev.name};
};

const get_release = ()=>{
    try {
        const release_info = lri.releaseInfo({mode: 'sync'});
        return [
            release_info.id,
            release_info.version_id,
            release_info.arch,
        ].join('_');
    } catch(e){
        zerr.warn(e.message);
        return 'unknown';
    }
};

const tunnel_init = (msg, conn, cid, from, opt={})=>{
    if (from=='proxyjs')
    {
        zerr.perr('20_svc_connected', {}, {funnel: true, sdk: true});
        zerr.perr('connected', {}, {once: true});
    }
    if (msg)
    {
        Object.assign(global_opt, msg);
        const ext_ip = msg.ext_ip;
        if (!ext_ip)
        {
            // should never happen
            zerr.err('no ext_ip (%s): %s', from, msg);
            zerr.perr('dev_conn_no_ext_ip', {}, {once: true, log_tail: true});
            zerr.perr('dev_conn_no_ext_ip_'+from, {},
                {once: true, log_tail: true});
        }
    }
    const info = ip_type(conn.local_addr, E.devs);
    zerr.notice('js peer init from '+conn.local_addr+' '+
        (info ? info.name+' '+(info.type||'unknown') : ''));
    if (!info)
        zerr('connection info unknown %s %O', conn.local_addr, E.devs);
    let old_cid;
    try {
        old_cid = file.read(`${ver_conf.confdir}/oldcid`);
    } catch(e){
        zerr('jscid read err '+zerr.e2s(e));
    }
    const res = {
        arch: ver_conf.arch || ver_conf.device_profile?.arch || 'x64',
        release: ver_conf.release || ver_conf.device_profile?.release || 'unknown',
        platform: ver_conf.tv_platform || 'node',
        version: reported_version(),
        cid,
        old_cid,
        is_tv: ver_conf.is_tv,
        appid: alias.compute(ver_conf.appid,
            ver_conf.tv_platform||'node'),
        partnerid: ver_conf.partnerid,
        uuid,
        type: ver_conf.iftype || ver_conf.device_profile?.iftype || info && info.type,
        ifname: ver_conf.ifname || ver_conf.device_profile?.ifname || info && info.name,
        usage: {},
        consent_ts,
        last_rmt_upd_success: read_last_rmt_upd_success(),
        vpn_profile_enabled: is_vpn_profile_enabled(),
    };
    if (opt.ipv6)
    {
        res.ipv6_supported = true;
        res.ipv6 = opt.ipv6;
        res.wan_ipv6 = opt.wan_ipv6;
    }
    if (conn.fallback_agent)
    {
        res.proxy = conn.fallback_agent_host;
        if (E.myip)
            res.myip = E.myip;
    }
    zerr.notice('tunnel_init resp: %O', res);
    return res;
};

// XXX vladislavs: fix in file.readdir_r_e
const escape_regexp = s=>s.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');
const readdir_r_e = (dir, opt)=>{
    dir = file.normalize(dir).replace(/\/+$/, '');
    const strip = new RegExp(`^${escape_regexp(dir)}/`);
    return file.find_e(dir, Object.assign({strip}, opt));
};
const log_filter_regex = /\.(log|json)$/;
const get_log_filename = name=>`${ver_conf.confdir}/${name}`;
const log_ops = async(msg, conn)=>{
    const {action='list', name, compress, vfd} = msg;
    let idx, filename;
    const res = {action, name};
    if (typeof action!='string' || name && typeof name!='string')
    {
        res.err = 'invalid request';
        return res;
    }
    try {
        zerr.notice('log dir: '+ver_conf.confdir);
        const files = readdir_r_e(ver_conf.confdir)
            .filter(f=>log_filter_regex.test(f));
        zerr.notice('log files: %s', JSON.stringify(files));
        if (action=='list')
        {
            res.files = files.reduce((r, v)=>{
                const f = get_log_filename(v);
                try { r[v] = {size: file.size_e(f), mtime: file.mtime_e(f)}; }
                // eslint-disable-next-line
                catch(_e){ zerr.err(`stat ${f} failed: `+zerr.e2s(_e)); }
                return r;
            }, {});
            zerr.notice('log res.files: %s', JSON.stringify(res.files));
        }
        else if (!name)
            res.err = 'no name specified';
        else if ((idx = files.indexOf(name))<0)
            res.err = `file ${name} is not listed`;
        else if (!file.exists(filename = get_log_filename(files[idx])))
            res.err = `file ${name} does not exist`;
        else if (action=='fetch')
        {
            if (vfd)
            {
                let str = fs.createReadStream(filename);
                if (compress)
                    str = str.pipe(zlib.createDeflate());
                str.pipe(conn.mux.open(vfd, undefined, {use_ack: true}));
                res.vfd = vfd;
            }
            else
            {
                const data = file.read_e(filename, null);
                if (compress)
                {
                    await new Promise(resolve=>{
                        zlib.deflate(data, (err, b)=>{
                            if (err)
                                res.err = err.message||err;
                            else
                                res.data = b;
                            resolve();
                        });
                    });
                }
                else
                    res.data = data;
            }
        }
        else
            res.err = `unsupported action: ${action}`;
    } catch(e){
        zerr('log_ops err '+zerr.e2s(e));
        res.err = e.message||'unknown error';
    }
    return res;
};

const heartbeat_interval = (name, dev, opt)=>{
    const interval = opt.interval||ms.MIN;
    const progressive = opt.progressive;
    const heartbeat_name = `heartbeat_${name}_${dev}`;
    let running = true;
    (async()=>{
        const last_heartbeat = user_settings &&
            user_settings.get(heartbeat_name);
        if (last_heartbeat && last_heartbeat<5*ms.MIN)
        {
            await zerr.perr(`heartbeat_too_short_${name}`,
                {dev: dev, heartbeat: last_heartbeat},
                {log_tail: true, sdk: true});
        }
        let sum = 0;
        let cur = interval;
        // eslint-disable-next-line no-unmodified-loop-condition
        for (let i=0; running; i++)
        {
            // eslint-disable-next-line no-unmodified-loop-condition
            for (let j=0; j<cur && running; j+=interval)
            {
                if (user_settings)
                    user_settings.set(heartbeat_name, sum+j+1);
                await sleep(interval);
            }
            if (!running)
                break;
            sum += cur;
            const n = sprintf('%02d', i);
            const dur = date.dur_to_str(sum);
            await zerr.perr(`heartbeat_${name}_${n}_${dur}`, {}, {sdk: true});
            if (progressive)
                cur = interval*Math.pow(2, i);
        }
    })().catch(e=>zerr('heartbeat err '+zerr.e2s(e)));
    return {return: ()=>{ running = false; }};
};

const resolve_addr_allowed = async(host, allowed)=>{
    let ips, first = true;
    try {
        ips = await resolve_addr(host);
    } catch(e){
        zerr(zerr.e2s(e));
    }
    if (!ips || !ips.length)
        return;
    if (!process.zon && env.RESOLVE_ALLOW_ANY)
        return ips;
    for (let ip of ips)
    {
        if (!allowed || allowed.includes(ip.address))
            return ips;
        let details = first ? `resolved: ${ips}, failed ${ip.address}` :
            `failed ${ip.address}`;
        first = false;
        zerr.err(`restricted_domain: ${host} ${details}`);
        if (ips.length < allowed.length)
        {
            zerr.perr('restricted_domain', {host, details, allowed},
                {once: true});
        }
    }
};

const conn_open_single = async(opt, dev)=>{
    let hosts = sdk_conf.lum_proxy_domains;
    let ports = sdk_conf.lum_proxy_ports;
    let alt_hosts = sdk_conf.lum_proxy_domains_a1;
    let alt_ports = sdk_conf.lum_proxy_ports;
    let alt_ips = sdk_conf.lum_proxy_ips_a1;
    let allowed_ips = !env.ZLXC && sdk_conf.lum_proxy_ips;
    let agent_hosts = sdk_conf.lum_zagent_domains;
    let agent_ports = sdk_conf.lum_zagent_ports_ssl;
    let agent_ips = sdk_conf.lum_zagent_ips_ssl;
    let host_idx = 0;
    let port_idx = 0;
    let reset;
    let ip_try_count = 0;
    let next_wait = 10*ms.SEC;
    let force_ip = env.ZLXC ? '1.1.1.10' : undefined;
    let force_host;
    let force_port;
    let force_proxy;
    let fallback_ip = false;
    let fallback_agent = false;
    for (;;)
    {
        if (dev && !dev.is_connected())
        {
            zerr.notice('dev %s offline, exiting...', dev.name);
            return;
        }
        let ip, host, port, proxy;
        if (fallback_agent)
        {
            ip = {address: force_ip||get_rand_elm(allowed_ips), family: 4};
            host = force_host||hosts[0];
            port = force_port||ports[0];
            if (force_proxy)
                proxy = force_proxy;
            else
            {
                let agent_host = get_rand_elm(agent_hosts);
                let agent_ip = rand_uniform.rand_element(agent_ips);
                let agent_port = get_rand_elm(agent_ports);
                proxy = force_proxy||{
                    protocol: 'https:',
                    host: agent_ip,
                    port: agent_port,
                    servername: util.gen_servername(agent_ip, agent_host),
                };
            }
            zerr.notice(
                `conn_open_single ${host}:${port} proxy ${proxy.servername}`);
        }
        else
        {
            if (fallback_ip)
            {
                host = force_host||alt_hosts[host_idx];
                port = force_port||alt_ports[port_idx];
            }
            else
            {
                host = force_host||hosts[host_idx];
                port = force_port||ports[port_idx];
            }
            zerr.notice(`conn_open_single ${host}:${port} `+
                `${fallback_ip ? 'fallback_ip' : ''}`);
            let ips;
            if (force_ip)
                ips = [{address: force_ip, family: 4}];
            else if (fallback_ip)
                ips = alt_ips.map(_ip=>({address: _ip, family: 4}));
            else
            {
                ips = await resolve_addr_allowed(host, allowed_ips);
                if (!ips)
                {
                    if (++host_idx>=hosts.length)
                    {
                        fallback_ip = true;
                        zerr.perr('proxyjs_dns_failed', {host, port},
                            {log_tail: true});
                    }
                    zerr(`conn_open_single failed resolve ${host}`);
                    continue;
                }
            }
            ip = rand_uniform.rand_element(ips);
        }
        const method = fallback_agent ? '02_agent' : fallback_ip ?
            '01_ip' : '00_direct';
        const open_res = await proxyjs_client_conn(opt, ip.address, port,
            host, proxy, method);
        force_ip = undefined;
        force_host = undefined;
        force_port = undefined;
        force_proxy = undefined;
        if (open_res && open_res.last_success)
        {
            ip_try_count = 0;
            next_wait = global_opt.proxy_retry_interval;
            let redir = open_res.main_conn && open_res.main_conn.redirect_req;
            if (redir)
            {
                force_ip = redir.ip;
                force_host = redir.host;
                force_port = redir.port;
                force_proxy = proxy;
                // assume we still need agent fallback even on redirect
                if (!fallback_agent)
                    fallback_ip = false;
                reset = false;
            }
            else // first retry on success should be to same proxyjs server
            {
                force_ip = ip.address;
                force_host = host;
                force_port = port;
                force_proxy = proxy;
            }
        }
        else
        {
            if (fallback_agent)
            {
                ip_try_count++;
                if (ip_try_count>2 || ip_try_count>=agent_ips.length)
                {
                    reset = true;
                    zerr.perr('proxyjs_conn_02_agent_failed', {host, port, ip,
                        proxy}, {log_tail: true});
                }
            }
            else if (fallback_ip)
            {
                // we want to go over all alt_hosts/alt_ports permutations but
                // also make sure we test a minimum amount of alt_ips
                ip_try_count++;
                port_idx++;
                if (port_idx>=alt_ports.length)
                {
                    port_idx = 0;
                    host_idx++;
                }
                if (host_idx>=alt_hosts.length)
                {
                    if (ip_try_count>2 || ip_try_count>=alt_ips.length)
                    {
                        ip_try_count = 0;
                        fallback_agent = true;
                        zerr.perr('proxyjs_conn_01_ip_failed', {host, port,
                            ip: ip.Address}, {log_tail: true});
                    }
                    else
                        host_idx = port_idx = 0;
                }
            }
            else
            {
                port_idx++;
                if (port_idx>=ports.length)
                {
                    port_idx = 0;
                    host_idx++;
                }
                if (host_idx>=hosts.length)
                {
                    fallback_ip = true;
                    host_idx = port_idx = 0;
                    zerr.perr('proxyjs_conn_00_direct_failed',
                        {host, port, ip: ip.Address}, {log_tail: true});
                }
            }
            if (!reset)
            {
                // while trying to figure out how to reach server no need for
                // long wait between retries
                await sleep(1000);
                continue;
            }
            else
            {
                ip_try_count = 0;
                host_idx = port_idx = 0;
                fallback_ip = fallback_agent = false;
                reset = false;
            }
        }
        const cooldown = open_res && open_res.last_success &&
            open_res.main_conn && open_res.main_conn.cooldown;
        if (cooldown)
        {
            zerr.info(`conn_open_single cooldown ${cooldown}ms to next check`);
            await sleep(cooldown);
            continue;
        }
        zerr.info(`conn_open_single sleeping ${next_wait}ms to next check`);
        await sleep(next_wait);
        next_wait = Math.min(next_wait*2, global_opt.proxy_retry_max);
    }
};

class Device extends events.EventEmitter {
    constructor(device){
        super();
        let {name, addr, addr_ipv6} = device;
        this.name = name;
        this.addr = addr;
        this.addr_ipv6 = addr_ipv6;
        this.ipv6_enabled = false;
        this.netmask_v6 = device.netmask_v6;
        this.netmask_v4 = device.netmask_v4;
        this.state = 'unknown';
        this.sp = new Task();
        this.sp.finally(()=>this.close());
        this.on('connected', this._on_connected);
        this.on('disconnected', this._on_disconnected);
        this.on('wait_test', this._on_wait_test);
        this.next_wait = 10*ms.SEC;
        this.test();
    }
    test(){
        zerr.notice(`dev ${this.name} testing`);
        let _this = this;
        this.state = 'test';
        this.sp.spawn((async()=>{
            const sites = sdk_conf.lum_test_sites;
            const test_sites = rand_uniform.rand_subset(sites, sites.length);
            for (let site of test_sites)
            {
                let ret = false;
                try {
                    ret = await _this.test_site(site, 'resolve4', _this.addr);
                } catch(e){
                    zerr.notice(`${_this.name} test failed url=${site.url} ${
                        zerr.e2s(e)}`);
                }
                if (!ret)
                    continue;
                if (_this.addr_ipv6)
                    await _this.test_ipv6();
                _this.set_state('connected');
                return;
            }
            _this.set_state('wait_test');
        })());
    }
    async test_ipv6(){
        const _this = this;
        const sites = sdk_conf.lum_test_ipv6_sites;
        zerr.notice(`${_this.name} testing ipv6 ${_this.addr_ipv6}`);
        for (let site of sites)
        {
            try {
                if (await _this.test_site(site, 'resolve6',
                    _this.addr_ipv6))
                {
                    _this.ipv6_enabled = true;
                    zerr.perr('ipv6_101_test_success',
                        {msg: _this.addr_ipv6}, {once: true});
                    return true;
                }
            } catch(e){
                zerr.perr('ipv6_102_test_fail', {err: zerr.e2s(e)},
                    {once: true});
            }
        }
        _this.ipv6_enabled = false;
        return false;
    }
    async test_site(site, resolve_type, local_addr){
        const _this = this;
        let parts = new URL(site.url);
        const host = parts.host;
        let ip = site.ip;
        if (!zurl.is_ip(parts.hostname))
        {
            try {
                let addr = await resolve_addr(parts.host,
                    resolve_type);
                if (addr)
                    [ip] = addr;
            } catch(e){
                zerr.notice('resolve_addr_failed: '+zerr.e2s(e));
            }
        }
        const params = {
            path: parts.pathname+parts.search,
            protocol: parts.protocol,
            hostname: ip||parts.hostname,
            method: 'GET',
            timeout: ms.MIN,
            headers: {host},
            localAddress: local_addr,
            redir: 3,
        };
        const res = await util.request(params);
        if (res.error || !res.data || !res.data.length)
        {
            zerr.notice(`${_this.name} test failed ${res.status} ${
                res.error}`);
            return false;
        }
        if (!res.data.match(site.match))
        {
            zerr.notice(`${_this.name} test no match ${site.url} ${
                site.match} '${res.data}'`);
            return;
        }
        zerr.notice(`${_this.name} matched ${site.url}`);
        // currently obsolete flag
        if (site.myip)
        {
            try {
                E.myip_s = res.data.trim();
                E.myip = JSON.parse(E.myip_s);
                E.myip.ts = date.monotonic();
                if (E.myip.ip==_this.addr)
                {
                    _this.no_nat = true;
                    E.myip.no_nat = true;
                }
            } catch(e){
                zerr.perr('test_myip_failed', {
                    site,
                    error: zerr.e2s(e),
                    body: res.data,
                }, {once: true});
            }
        }
        if (resolve_type=='resolve6')
        {
            const json = JSON.parse(res.data.trim());
            const _ip = json.ip || json.address;
            if (!_ip)
            {
                zerr.notice(
                    `${_this.name} matched ipv6 /w json error`);
                return false;
            }
            _this.wan_ipv6 = _ip;
        }
        return true;
    }
    set_state(state){
        let prev_state = this.state;
        this.state = state;
        this.emit(state, prev_state);
    }
    is_connected(){
        return this.state=='connected';
    }
    _on_connected(){
        zerr.notice('dev %s connected', this.name);
    }
    _on_disconnected(prev_state){
        if (prev_state!='connected')
            return;
        zerr.notice('dev %s disconnected', this.name);
    }
    _on_wait_test(){
        const _this = this;
        const wait_ms = this.next_wait;
        zerr.notice(`${this.name} sleeping ${wait_ms} to next check`);
        this.next_wait = Math.min(this.next_wait*2, ms.MIN*30);
        this.sp.spawn((async()=>{
            await sleep(wait_ms);
            _this.test();
        })());
    }
    close(){
        this.set_state('disconnected');
    }
}

// main connection to zs-proxyjs
class Main_conn {
    constructor(client, name, opt){
        this.client = client;
        this.name = name;
        this.cid = undefined;
        this.client.data = this;
        this.redirect_req = undefined;
        this.cooldown = undefined;
        this.opt = opt;
    }
    tunnel_init(msg){
        return tunnel_init(msg, this.client, undefined, 'proxyjs', this.opt);
    }
    status_get(msg){
        return status_get(msg);
    }
    tunnel_redirect(msg){
        if (!msg)
            return;
        zerr.notice(`${this.name} tunnel_redirect ${msg.ip}`);
        this.redirect_req = msg;
        this.close();
    }
    connect(msg){
        return client_connect(msg, this.client, this.cid);
    }
    cid_set(msg){
        zerr.notice(`${this.name} cid_set ${msg.cid}
            session_key ${msg.session_key}`);
        this.cid = E.cid_js = msg.cid;
        try {
            zerr.perr('register_client', {
                msg: msg.cid.split('/')[1],
                body: JSON.stringify({type: this.name, myip: E.myip_s}),
            });
        } catch(e){
            zerr(zerr.e2s(e));
        }
        E.session_key_js = msg.session_key;
        file.write(`${ver_conf.confdir}/oldcid`, msg.cid);
    }
    sdk_update(msg){
        zerr('not implemented');
    }
    logs(msg){
        return log_ops(msg, this.client);
    }
    tunnel_init_decline(msg){
        zerr.notice('tunnel_init_decline: %s', msg.reason);
        const cooldown_ms = msg.cooldown_ms||ms.DAY;
        zerr.notice(`${this.name} connect decline cooldown ${cooldown_ms}`);
        this.cooldown = cooldown_ms;
        this.close();
    }
    consent(msg){
        let {missing} = msg;
        if (!missing)
            return;
        zerr.notice(`${this.name} consent missing`);
        if (user_settings)
        {
            let sdk = user_settings.get('sdk')||{};
            if (!sdk.consent)
                sdk.consent = {};
            sdk.consent.missing = new Date();
            user_settings.set('sdk', sdk);
        }
    }
    close(){
        this.client.close();
    }
}

let main_conn;
const proxyjs_client_conn = async(opt, ip, port, servername, proxy, method)=>{
    let {name, addr, addr_ipv6} = opt||{};
    let disconnected = false;
    if (!opt)
        name = 'single_conn';
    zerr.notice(`proxyjs_client_conn ${name} ${addr} ${ip}:${port}`+
        `(${servername}) ${util.print_zagent(proxy)}`);
    let agent, proxy_opt;
    if (ver_conf.proxy)
    {
        const {SocksProxyAgent} = require('socks-proxy-agent');
        agent = new SocksProxyAgent(ver_conf.proxy);
    }
    else if (proxy)
    {
        proxy.headers = Object.assign({
            'x-uuid': uuid,
            'x-forwarded-host': servername,
            'x-forwarded-port': port,
            'x-forwarded-proto': 'https',
        }, proxy.headers);
        proxy_opt = Object.assign({ca: util.get_root_ca(),
            checkServerIdentity: cert_pin.check_server_identity}, proxy);
    }
    else
    {
        agent = new https.Agent({localAddress: addr, servername,
            ca: util.get_root_ca(),
            checkServerIdentity: cert_pin.check_server_identity});
    }
    const client = new zws.Client(`wss://${ip}:${port}`, {
        label: 'proxy_'+name,
        agent,
        proxy: proxy_opt,
        servername,
        ping_interval: global_opt.proxy_ping_interval,
        ping_timeout: global_opt.proxy_ping_timeout,
        handshake_timeout: global_opt.proxy_handshake_timeout,
        ipc_server: [
            'tunnel_init',
            'status_get',
            'tunnel_redirect',
            'connect',
            'cid_set',
            'logs',
            'tunnel_init_decline',
            'consent',
        ],
        ipc_client: {pins_update: 'call'},
        ipc_zjson: true,
        mux: true,
    });
    client.device_info = opt;
    client.addr_ipv6 = addr_ipv6;
    if (proxy)
    {
        client.fallback_agent = true;
        client.fallback_agent_host = proxy.host;
    }
    let last_success;
    let heartbeat;
    let resolve_fn;
    const p = new Promise(res=>{ resolve_fn = res; });
    client.on('connected', ()=>{
        last_success = true;
        zerr.notice('proxy connected');
        zerr.perr(`proxyjs_conn_${method}_success`,
            {servername, port, ip, proxy});
        heartbeat = heartbeat_interval('proxy_js_conn', name,
            {interval: ms.MIN, progressive: true});
    });
    client.on('disconnected', ()=>{
        zerr.notice('proxy disconnected');
        client.close();
        disconnected = true;
        resolve_fn({last_success, main_conn});
    });
    main_conn = new Main_conn(client, name, opt);
    try {
        return await p;
    } finally {
        if (!disconnected)
            client.close(-2, 'shutdown');
        if (heartbeat)
            heartbeat.return();
        if (agent)
            agent.destroy();
    }
};

const VPN_IFACE_RE =
    /^(tun|ppp|wg|ipsec|tailscale|gpd)\d*$|^utun[1-9]\d*$|^vpn\d*$/;
const update_vpn_profile_enabled = devs=>{
    if (!process.env.IS_TIZEN && ver_conf.tv_platform!='webos'
        && !ver_conf.debug)
    {
        vpn_profile_enabled = devs.some(i=>VPN_IFACE_RE.test(i.name));
    }
};
const is_vpn_profile_enabled = ()=>vpn_profile_enabled;

const get_devs = ()=>{
    const ifs = os.networkInterfaces();
    return Object.entries(ifs).reduce((recs, [name, addresses])=>{
        let rec = addresses.reduce((acc, address)=>{
            if (address.internal
                || address.address == '0.0.0.0'
                || address.address.startsWith('fe80::'))
            {
                return acc;
            }
            if (address.family=='IPv4')
            {
                acc.addr = address.address;
                acc.netmask_v4 = address.netmask;
            }
            else if (address.family=='IPv6')
            {
                acc.addr_ipv6 = address.address;
                acc.netmask_v6 = address.netmask;
            }
            return acc;
        }, {name});
        if (rec.addr)
            recs.push(rec);
        return recs;
    }, []);
};

const has_devs_changed = devs=>{
    if (!E.devs && devs || E.devs && !devs)
        return true;
    if (E.devs.length!=devs.length)
        return true;
    for (let i=0; i<E.devs.length; i++)
    {
        if (E.devs[i].name!=devs[i].name || E.devs[i].addr!=devs[i].addr)
            return true;
    }
    return false;
};

const check_devs = ()=>{
    const devs = get_devs();
    zerr.info('detected %s devs: %s', devs.length,
        devs.map(d=>`${d.name}:${d.addr}`).join(', '));
    if (!has_devs_changed(devs))
        return;
    zerr.notice(`devs changed: found ${devs.length} devs`);
    for (let {name, addr, addr_ipv6} of devs)
    {
        zerr.notice(`interface detected: ${name} (${addr}) (${
            addr_ipv6||'N/A'})`);
    }
    handle_devs(devs);
};
let net_mon;
const start_monitor_devs = ()=>{
    const interval = ms.SEC;
    let running = true;
    (async()=>{
        // eslint-disable-next-line no-unmodified-loop-condition
        while (started && running)
        {
            check_devs();
            await sleep(interval);
        }
    })().catch(e=>zerr('perr err '+zerr.e2s(e)));
    return {return: ()=>{ running = false; }};
};

const dev_init = device_info=>{
    zerr.notice(`dev ${device_info.name} init`);
    const dev = new Device(device_info);
    dev.on('connected', ()=>{
        zerr.notice('device online: %s, connecting...', dev.name);
        if (dev.ipv6_enabled)
        {
            device_info.ipv6 = dev.addr_ipv6;
            device_info.wan_ipv6 = dev.wan_ipv6;
        }
        dev.sp.spawn(conn_open_single(device_info, dev));
    });
    return {
        enabled: true,
        name: device_info.name,
        sp: dev.sp,
        addr: device_info.addr,
        data: device_info,
    };
};

const devs = {};
const handle_devs = _devs=>{
    E.devs = _devs;
    update_vpn_profile_enabled(_devs);
    for (let name in devs)
        devs[name].enabled = false;
    for (let d of E.devs)
    {
        let {name, addr} = d;
        // ip changed on the same iface
        if (devs[name] && devs[name].addr!=addr)
        {
            zerr.notice(`dev ${name} change ${devs[name].addr}->${addr}`);
            devs[name].sp.return();
            delete devs[name];
        }
        // iface was exisiting last time
        if (devs[name])
        {
            devs[name].enabled = true;
            continue;
        }
        // initialize new iface
        devs[name] = dev_init(d);
    }
    // cleanup of ifaces: release those not in use
    for (let name in devs)
    {
        const dev = devs[name];
        if (dev.enabled)
            continue;
        zerr.notice(`dev ${name} disabled`);
        dev.sp.return();
        delete devs[dev.name];
    }
};
const get_tracking_id_file = ()=>`${ver_conf.confdir}/tracking_id`;
const get_step_file = ()=>`${ver_conf.confdir}/step`;

const init_tracking_id = conf=>{
    if (conf.tracking_id)
    {
        zerr.notice('write tracking_id: %s', conf.tracking_id);
        write_tracking_id(conf.tracking_id);
    }
    else
    {
        if (conf.tracking_id = read_tracking_id()||'')
            zerr.notice('read tracking_id: %s', conf.tracking_id);
        else
            zerr.notice('tracking_id not set');
    }
    return conf.tracking_id;
};

const read_tracking_id = ()=>{
    const tracking_id_file = get_tracking_id_file();
    try {
        if (!file.exists(tracking_id_file))
        {
    	    zerr.notice('tracking_id file does not exist: %s',
                tracking_id_file);
            return;
        }
        const _tracking_id = file.read_e(tracking_id_file);
        zerr.notice('read tracking_id from file: %s -> %s',
            tracking_id_file, _tracking_id);
        return _tracking_id;
    } catch(e){
        zerr.err('failed to read tracking id file: %s', zerr.e2s(e));
    }
};

const write_tracking_id = tracking_id=>{
    const tracking_id_file = get_tracking_id_file();
    try {
        if (!file.exists(tracking_id_file))
            file.touch(tracking_id_file);
        zerr.notice('write tracking_id to file: %s -> %s',
            tracking_id_file, tracking_id);
        file.write(tracking_id_file, tracking_id);
    } catch(e){
        zerr.err('failed to write tracking id file: %s', zerr.e2s(e));
    }
};

E.init_zerr = zerr_svc=>{
    zerr.set_logger(zerr_svc);
};

const gen_uuid = uuid_file=>{
    let platform = 'node';
    if (ver_conf && ver_conf.tv_platform)
        platform = ver_conf.tv_platform;
    const val = `sdk-${platform}-${uuid_gen.v4().replace(/-/g, '')}`;
    uuid = val;
    try {
        zerr.notice('generated uuid: %s', val);
        file.write_e(uuid_file, val, {mkdirp: 1});
    } catch(e){
        zerr('failed to save uuid to file: %s', zerr.e2s(e));
    }
};

E.generate_uuid = (_ver_conf, {force=false}={})=>{
    const uuid_file = `${_ver_conf.confdir}/uuid`;
    if (!force && file.read(uuid_file))
        return;
    gen_uuid(uuid_file);
};

E.regenerate_uuid = _ver_conf=>E.generate_uuid(_ver_conf, {force: true});

const init_uuid = ()=>{
    const uuid_file = `${ver_conf.confdir}/uuid`;
    try {
        if (file.exists(uuid_file))
        {
            const val = file.read(uuid_file);
            if (val==null || !val.startsWith('sdk-'))
                return;
            return uuid = val;
        }
    } catch(e){
        zerr('failed to retrieve uuid from file: %s', zerr.e2s(e));
    }
    gen_uuid(uuid_file);
};

const init_process = ()=>{
    process.on('exit', ()=>console.log('exiting'));
    process.on('SIGUSR2', ()=>{
        if (started)
            return E.stop();
        E.start();
    });
};

const watch_status = ()=>{
    const status_file = `${ver_conf.confdir}/status`;
    const apply_status = ()=>{
        const stat = file.read(status_file);
        if (!stat)
            throw Error('status_file does not exist: '+status_file);
        if (stat.startsWith('enabled'))
            E.start();
        else if (stat.startsWith('disabled'))
            E.stop();
    };
    fs.watchFile(status_file, ()=>{
        apply_status();
    });
    apply_status();
};

let pre_init_called = false;
let tracking_id;

E.pre_init = conf=>{
    if (pre_init_called)
        return;
    pre_init_called = true;
    util.set_conf(conf);
    init_std();
    zerr.notice(`running PID: ${process.pid}`);
    init_uuid();
    conf.uuid = uuid;
    perr.init(sdk_conf);
    tracking_id = init_tracking_id(conf);
    zerr.perr_install(perr.install(conf));
    web_request.init({
        uuid,
        version: reported_version(),
        lum_zagent_ports_ssl: sdk_conf.lum_zagent_ports_ssl,
        lum_zagent_ips_ssl: sdk_conf.lum_zagent_ips_ssl,
        lum_zagent_domains: sdk_conf.lum_zagent_domains,
    });
    consent_read();
};
E.init = conf=>{
    E.pre_init(conf);
    // should never be called before web_request.init
    cloud_conf.run_background(sdk_conf);
    init_process();
    zerr.perr('05_svc_init', {}, {funnel: true, sdk: true});
    zerr.perr('init', {}, {once: true});
    if (!idle_monitor_et)
        idle_monitor_et = idle_state_monitor();
    set_blocked_ip(sdk_conf.lum_blocked_ips);
    perr.process();
    cert_pin.init(ver_conf.confdir);
    cert_pin.set_conn_getter(()=>main_conn && main_conn.client);
    if (ver_conf.watch_status_file)
        watch_status();
};

E.perr = (...args)=>zerr.perr(...args);

E.stop = ()=>{
    zerr.notice('run: E.stop()');
    zerr.notice('stopping peer: releasing all ifaces');
    started = false;
    if (!process.env.IS_TIZEN && net_mon)
        net_mon.stop_monitoring();
    for (let name in devs)
    {
        const dev = devs[name];
        dev.sp.return();
        delete devs[dev.name];
    }
    if (monitor_et)
    {
        monitor_et.return();
        monitor_et = null;
    }
    E.devs = {};
    vpn_profile_enabled = false;
};

E.uninit = ()=>{
    if (started)
        E.stop();
    if (idle_monitor_et)
    {
        idle_monitor_et.return();
        idle_monitor_et = null;
    }
};

E.start_by_svc = ()=>{
    zerr.notice('run: E.start_by_svc()');
    E.start();
};

E.start = ()=>{
    zerr.notice('run: E.start()');
    started = true;
    if (!monitor_et)
        monitor_et = start_monitor_devs();
};

const get_consent_file = ()=>`${ver_conf.confdir}/consent`;
let consent_status;
let consent_ts;
let last_rmt_upd_success;

const get_last_rmt_upd_success_file = ()=>
    `${ver_conf.confdir}/last_rmt_upd_success`;

const read_last_rmt_upd_success = ()=>{
    if (last_rmt_upd_success!==undefined)
        return last_rmt_upd_success;
    const last_rmt_upd_success_file = get_last_rmt_upd_success_file();
    if (!file.exists(last_rmt_upd_success_file))
    {
        last_rmt_upd_success = null;
        return last_rmt_upd_success;
    }
    try {
        const value = +file.read_e(last_rmt_upd_success_file);
        last_rmt_upd_success = Number.isFinite(value) && value>0
            ? value : null;
    } catch(e){
        zerr.err('failed to read last remote update time: %s', zerr.e2s(e));
        last_rmt_upd_success = null;
    }
    return last_rmt_upd_success;
};

const write_last_rmt_upd_success = ts=>{
    const last_rmt_upd_success_file = get_last_rmt_upd_success_file();
    last_rmt_upd_success = ts;
    if (!file.exists(last_rmt_upd_success_file))
        file.touch(last_rmt_upd_success_file);
    file.write(last_rmt_upd_success_file, `${last_rmt_upd_success}`);
};

const consent_write = (consent, ts)=>{
    const consent_file = get_consent_file();
    if (consent==null)
        return;
    consent_status = +consent;
    consent_ts = ts||Date.now();
    if (!file.exists(consent_file))
        file.touch(consent_file);
    file.write(consent_file, `${consent_status}:${consent_ts}`);
};
const consent_read = ()=>{
    const consent_file = get_consent_file();
    if (!file.exists(consent_file))
    {
        consent_status = null;
        consent_ts = null;
        return;
    }
    try {
        consent_status = file.read_e(consent_file);
        zerr.notice('consent status: %s', consent_status);
        if (/^[01]$/.test(consent_status))
        {
            // old consent format, convert to new format
            consent_ts = file.mtime_e(consent_file);
            consent_status = +consent_status;
            consent_write(consent_status, consent_ts);
        }
        else
        {
            const parts = consent_status.split(':');
            if (parts.length==2)
            {
                // some old version using the new format used to write
                // true/false instead of 0/1
                consent_status = parts[0]=='true' ? 1 :
                    parts[0]=='false' ? 0 : +parts[0];
                consent_ts = +parts[1];
            }
            else
            {
                zerr('invalid consent status format: %s', consent_status);
                consent_status = null;
                consent_ts = null;
            }
        }
    } catch(e){
        zerr.err('failed to read consent file: %s', zerr.e2s(e));
        consent_status = null;
        consent_ts = null;
    }
};

E.update_consent = consent=>{
    zerr.notice('run: E.update_consent(%s)', consent);
    if (consent)
    {
        zerr.perr('15_choose_peer', {}, {funnel: true, sdk: true});
        zerr.perr('opt_in');
    }
    else
        zerr.perr('opt_out');
    consent_write(consent);
};

E.dialog_shown = ()=>{
    zerr.perr('10_show_dialog', {}, {funnel: true, sdk: true});
    zerr.perr('display', {}, {once: true});
};

E.update_step = step=>{
    zerr.notice('run: E.update_step(%s)', step);
    const step_file = get_step_file();
    if (!file.exists(step_file))
        file.touch(step_file);
    file.write(step_file, step);
};

const read_step = ()=>{
    const step_file = get_step_file();
    if (!file.exists(step_file))
        return 0;
    try {
        return +file.read_e(step_file);
    } catch(e){
        zerr.err('failed to read step file: %s', zerr.e2s(e));
        return 0;
    }
};

E.get_status = ()=>{
    zerr.notice('run: E.get_status()');
    const step = read_step();
    consent_read();
    return {
        consent: consent_ts && !!consent_status,
        step,
        ver: reported_version(),
        uuid,
        tracking_id,
    };
};

E.get_server_sdk_conf = async()=>{
    var qs = {appid: alias.compute(ver_conf.appid,
        ver_conf.tv_platform||'node'), ver: reported_version()};
    const res = await web_request.get(sdk_conf.lum_clientsdk_domains,
        sdk_conf.sdk_conf_path, qs);
    if (res && res.status==200)
        write_last_rmt_upd_success(Date.now());
    return res;
};

E.log = log;

E.t = {
    validate_ipv6_target,
    set_blocked_ip,
    ip_in_list,
    get_connect_fallback_suffix,
    escape_regexp,
    ip_type,
    has_devs_changed,
    choose_local_addr,
    get_devs,
    VPN_IFACE_RE,
    update_vpn_profile_enabled,
    is_vpn_profile_enabled,
};
