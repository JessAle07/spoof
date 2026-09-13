import json,os,pathlib,shutil,subprocess,tempfile,time,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
NODE=shutil.which('node')

@unittest.skipUnless(NODE,'Node required')
class Runtime(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.data=pathlib.Path(self.tmp.name)/'data'
  self.env={**os.environ,'EDGE_DATA_DIR':str(self.data),'EDGE_CONSENT':'1','EARNAPP_CLIENT':'default','EARNAPP_VERSION_MODE':'local'}
 def command(self,cmd,**changes):
  return [NODE,'--require',str(ROOT/'tests/offline.cjs'),str(ROOT/'worker.cjs'),cmd],{**self.env,**changes}
 def run_worker(self):
  args,env=self.command('run');log=open(pathlib.Path(self.tmp.name)/'worker.log','w');self.addCleanup(log.close)
  proc=subprocess.Popen(args,env=env,stdout=log,stderr=log)
  def cleanup():
   if proc.poll() is None:proc.kill()
   proc.wait()
  self.addCleanup(cleanup)
  end=time.monotonic()+8
  while time.monotonic()<end:
   if (self.data/'status.json').exists():
    status=json.loads((self.data/'status.json').read_text())
    if status['phase']=='running':return proc,status
   if proc.poll() is not None:break
   time.sleep(.05)
  self.fail('SDK did not reach running state; inspect temporary runtime log')
 def test_all_platforms_run_without_uuid_whitespace(self):
  for name in ['ios','windows','macos','tizen','webos']:
   self.env['EARNAPP_CLIENT']=name
   # Remove only the global heartbeat so a previous profile is not mistaken for this one.
   (self.data/'status.json').unlink(missing_ok=True)
   proc,status=self.run_worker()
   self.assertEqual(status['selected_profile'],name)
   self.assertEqual(status['uuid'],status['uuid'].strip())
   self.assertTrue(status['uuid'].startswith('sdk-'+({'windows':'win','macos':'mac'}.get(name,name))+'-'))
   time.sleep(.1);self.assertIsNone(proc.poll())
   proc.terminate();self.assertEqual(proc.wait(timeout=5),0)
 def test_modules_load(self):
  args,env=self.command('check');r=subprocess.run(args,env=env,capture_output=True,text=True,timeout=10)
  self.assertEqual(r.returncode,0,r.stderr)
 def test_real_sdk_initializes_and_keeps_uuid_after_restart(self):
  proc,status=self.run_worker();self.assertRegex(status['uuid'],r'^sdk-node-[a-f0-9]{32}$')
  time.sleep(.2);self.assertIsNone(proc.poll())
  proc.terminate();self.assertEqual(proc.wait(timeout=5),0)
  self.assertEqual(json.loads((self.data/'status.json').read_text())['phase'],'stopped')
  again,new=self.run_worker();self.assertEqual(status['uuid'],new['uuid'])
  again.terminate();self.assertEqual(again.wait(timeout=5),0)
 def test_invalid_existing_identity_not_overwritten(self):
  p=self.data/'default';p.mkdir(parents=True);(p/'uuid').write_text('broken')
  args,env=self.command('run');r=subprocess.run(args,env=env,capture_output=True,text=True,timeout=5)
  self.assertEqual(r.returncode,1);self.assertEqual((p/'uuid').read_text(),'broken')
 def test_health_fails_without_recent_status(self):
  r=subprocess.run([NODE,str(ROOT/'tools/health.cjs')],env=self.env,timeout=5)
  self.assertEqual(r.returncode,1)
 def test_invalid_consent(self):
  args,env=self.command('run',EDGE_CONSENT='bad');r=subprocess.run(args,env=env,capture_output=True,text=True,timeout=5)
  self.assertEqual(r.returncode,1);self.assertIn('EDGE_CONSENT',r.stderr)

if __name__=='__main__':unittest.main()
