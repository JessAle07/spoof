const fs=require('node:fs');
const path=require('node:path');
try {
 const s=JSON.parse(fs.readFileSync(path.join(process.env.EDGE_DATA_DIR||'/data','status.json'),'utf8'));
 const age=Date.now()-Date.parse(s.updated_at);
 process.exit(['running','paused'].includes(s.phase)&&age>=0&&age<90000?0:1);
} catch {process.exit(1);}
