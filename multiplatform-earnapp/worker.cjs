'use strict';
// This entrypoint loads the editable SDK files directly. There is no bundle.
process.env.WS_NO_ZCOUNTER = '1';
const fs = require('node:fs');
const path = require('node:path');
const command = process.argv[2] || 'run';
const data = path.resolve(process.env.EDGE_DATA_DIR || '/data');
let confdir;
const output = value => fs.writeSync(1, typeof value === 'string' ? value+'\n' : JSON.stringify(value,null,2)+'\n');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const atomicJSON = (file, value) => {
    const tmp = file+'.'+process.pid+'.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value,null,2)+'\n');
    fs.renameSync(tmp, file);
};
if (command === 'help' || command === '--help') {
    output('Commands: run | register | status | profile | check\nConfiguration: config.json, EDGE_DATA_DIR, EDGE_CONSENT=1|0, EARNAPP_CLIENT, EARNAPP_SPOOF_CONFIG');
    process.exit(0);
}
if (!['run','register','status','profile','check'].includes(command)) {
    console.error('Unknown command. Use run, register, status, profile, or check.');
    process.exit(2);
}
if (command === 'status') {
    try { output(readJSON(path.join(data,'status.json'))); }
    catch (error) { console.error('No readable status file:',error.message);process.exitCode=1; }
} else if (command === 'profile') {
    try {
        const platforms=require('./platform.cjs');
        const p=platforms.selectProfile(process.env.EARNAPP_SPOOF_CONFIG||path.join(__dirname,'spoof_config.json'));
        output({selected_profile:p.name,tv_platform:p.tv_platform,is_tv:p.is_tv,
            appid:p.appid||readJSON(process.env.EDGE_CONFIG||path.join(__dirname,'config.json')).appid,uuid_prefix:'sdk-'+p.tv_platform+'-',hostname_prefix:p.hostname_prefix,
            registration:platforms.reportedRegistration(p),sdk_device_fields:p.spoof,
            fallback_to_first:p.fallback,state_directory:path.join(data,p.name)});
    } catch(error){console.error(error.message);process.exitCode=1;}
} else if (command === 'check') {
    require('./tools/check.cjs');
} else {
  (async () => {
    let sdk, heartbeat, stopping = false;
    const statusPath = path.join(data,'status.json');
    let metadata;
    function shutdown(code=0) {
        if (stopping) return;
        stopping = true;
        clearInterval(heartbeat);
        try { sdk?.uninit(); } catch (error) { console.error(error.message);code=1; }
        if (metadata) {
            try { atomicJSON(statusPath,{...metadata,phase:'stopped',updated_at:new Date().toISOString(),exit_code:code}); }
            catch (error) { console.error(error.message);code=1; }
        }
        // The SDK retains background timers after uninit; exit after a short flush.
        setTimeout(()=>process.exit(code),250);
    }
    process.on('SIGTERM',()=>shutdown(0));
    process.on('SIGINT',()=>shutdown(0));
    process.on('uncaughtException',error=>{console.error(error.stack);shutdown(1);});
    process.on('unhandledRejection',error=>{console.error(error);shutdown(1);});
    try {
        const config = readJSON(process.env.EDGE_CONFIG || path.join(__dirname,'config.json'));
        if (!config || typeof config!=='object' || Array.isArray(config)) throw Error('config.json must contain an object');
        if (typeof config.appid!=='string' || !config.appid.trim()) throw Error('config.json requires a nonempty appid');
        if (typeof config.debug!=='boolean') throw Error('config.json debug must be true or false');
        if (typeof config.log_file!=='string' || path.basename(config.log_file)!==config.log_file || ['.','..',''].includes(config.log_file))
            throw Error('log_file must be a filename without directory components');
        const consent = process.env.EDGE_CONSENT ?? '1';
        if (!['0','1'].includes(consent)) throw Error('EDGE_CONSENT must be 0 or 1');
        const platforms = require('./platform.cjs');
        const profile = platforms.selectProfile(process.env.EARNAPP_SPOOF_CONFIG || path.join(__dirname,'spoof_config.json'));
        if (profile.fallback) output(`[worker] Profile '${profile.requested}' not found; using first profile '${profile.name}' (reference behavior).`);
        if(config.appid==='earnapp.com') {config.appid='node_earnapp.com';output('[config] Corrected legacy appid to node_earnapp.com for reference compatibility.');}
        config.appid=profile.appid||config.appid;
        config.partnerid=config.partnerid||'luminati';
        ({confdir} = platforms.prepareIdentity(profile,data));
        if(profile.spoof.hostname&&!process.env.CONFIG_HOSTNAME)process.env.CONFIG_HOSTNAME=profile.spoof.hostname;
        output({selected_profile:profile.name,tv_platform:profile.tv_platform,registration:platforms.reportedRegistration(profile)});
        const sdkConfig = require('./sdk/sdk_conf.js');
        const version = require('./sdk/zon_config.json').ZON_VERSION;
        if (version!==sdkConfig.conf.ZON_VERSION)
            throw Error(`SDK files must match: runtime ${version}, configuration ${sdkConfig.conf.ZON_VERSION}`);
        const versions=await require('./version.cjs').resolveVersion();
        if(stopping)return;
        sdk = require('./sdk/client.js');
        const conf = {...config,confdir,tv_platform:profile.tv_platform,is_tv:profile.is_tv,
            device_profile:profile.spoof,...profile.spoof,mac:profile.mac,serial:profile.serial,tracking_id:profile.trackingId,proxy:profile.proxy,reported_version:versions.reported,watch_status_file:false};
        sdk.pre_init(conf);
        const status = sdk.get_status();
        metadata = {selected_profile:profile.name,tv_platform:profile.tv_platform,reported_device:profile.spoof,uuid:status.uuid,appid:config.appid,sdk_version:version,
            sdk_config_version:sdkConfig.conf.ZON_VERSION,reported_version:versions.reported,version_source:versions.source,started_at:new Date().toISOString(),
            connection_verified:false};
        const writeStatus = () => atomicJSON(statusPath,{...metadata,
            phase:consent==='1'?'running':'paused',updated_at:new Date().toISOString()});
        if (consent==='1' || command==='register') {
            const registration=await require('./registration.cjs').registerDevice({
                uuid:status.uuid,version:versions.reported,appid:config.appid,confdir,data,profile});
            output({account_link:registration.link,registration_cached:registration.cached});
            if (stopping) return;
        }
        if (command==='register') { shutdown(0);return; }
        sdk.init(conf);
        sdk.update_consent(consent==='1');
        if (consent==='1') sdk.start();
        writeStatus();
        heartbeat = setInterval(writeStatus,30000);
        output({message:'SDK initialized; this is not a registration or earnings confirmation',...metadata});
    } catch (error) {
        if(metadata) metadata.last_error=error.message;
        console.error(error.stack);shutdown(1);
    }
  })();
}
