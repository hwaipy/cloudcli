import importlib.util, importlib.machinery, sys, pathlib, tempfile, unittest, json, hashlib, tarfile
from unittest.mock import patch
BASE=pathlib.Path(__file__).resolve().parent.parent

def load(name,file):
 loader=importlib.machinery.SourceFileLoader(name,str(BASE/file));spec=importlib.util.spec_from_loader(name,loader)
 m=importlib.util.module_from_spec(spec);sys.modules[name]=m;loader.exec_module(m);return m
m=load('reload_front_test','reloadCloudCLI');r=load('release_test','reload-frontend-release.py')

def assets(p,text='new'):
 (p/'assets').mkdir(parents=True,exist_ok=True)
 (p/'assets/app.js').write_text(text)
 (p/'index.html').write_text('<script src="/cloudcli/assets/app.js"></script>')
 (p/'boot-assets.json').write_text(json.dumps({'assets':[{'file':'assets/app.js','bytes':len(text)}]}))

class FrontTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name).resolve();self.ps=[]
  for key,value in {'ROOT':self.root,'STATE_DIR':self.root/'state','FRONTEND_BUILD':self.root/'state/build','FRONTEND_RECEIPT':self.root/'state/receipt.json'}.items():
   p=patch.object(m,key,value);p.start();self.ps.append(p)
  (self.root/'src').mkdir();(self.root/'src/app.ts').write_text('a')
  self.calls=[]
 def tearDown(self):
  for p in self.ps:p.stop()
  self.tmp.cleanup()
 def build(self,*args,**kwargs):assets(m.FRONTEND_BUILD)
 def test_first_build_publish_then_skip(self):
  def remote(mode,*args):
   self.calls.append(mode)
   return {'matches':self.calls.count('check')>1} if mode=='check' else {'release':'/release/new'}
  with patch.object(m,'build_toolchain',return_value=(['node','npm','run','build:server'],{})),patch.object(m,'build_backend',side_effect=self.build) as build,patch.object(m,'frontend_remote',side_effect=remote),patch.object(m,'run',return_value='') as upload:
   self.assertIn('发布成功',m.restart_frontend());self.assertEqual(build.call_count,1);self.assertEqual(upload.call_count,1)
   self.assertIn('跳过',m.restart_frontend());self.assertEqual(build.call_count,1);self.assertEqual(upload.call_count,1)
   (self.root/'src/app.ts').write_text('b');m.restart_frontend();self.assertEqual(build.call_count,2)
 def test_build_failure_never_uploads(self):
  with patch.object(m,'build_toolchain',return_value=(['node','npm'],{})),patch.object(m,'build_backend',side_effect=RuntimeError('compile failure')),patch.object(m,'frontend_remote') as remote,patch.object(m,'run',return_value='') as upload:
   with self.assertRaisesRegex(RuntimeError,'compile failure'):m.restart_frontend()
   remote.assert_not_called();upload.assert_not_called()
 def test_bad_base_rejected(self):
  assets(m.FRONTEND_BUILD);(m.FRONTEND_BUILD/'index.html').write_text('<script src="/assets/app.js"></script>')
  with self.assertRaisesRegex(RuntimeError,'base'):m.validate_frontend()
 def test_uploaded_asset_missing_rejected(self):
  assets(m.FRONTEND_BUILD);(m.FRONTEND_BUILD/'assets/app.js').unlink()
  with self.assertRaisesRegex(RuntimeError,'缺少资源'):m.validate_frontend()

class RemoteTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name).resolve();self.p=patch.object(r,'ROOT',self.root);self.p.start()
  self.old=self.root/'releases/old';assets(self.old,'old');(self.root/'current').symlink_to(self.old)
  self.source=self.root/'build';assets(self.source)
  files={str(p.relative_to(self.source)):r.sha(p) for p in self.source.rglob('*') if p.is_file()}
  (self.source/'reload-manifest.json').write_text(json.dumps({'files':files}));self.digest=r.sha(self.source/'reload-manifest.json')
  self.archive=self.root/'upload.tar.gz'
  with tarfile.open(self.archive,'w:gz') as tar:
   for p in self.source.rglob('*'):
    if p.is_file():tar.add(p,arcname=str(p.relative_to(self.source)))
 def tearDown(self):self.p.stop();self.tmp.cleanup()
 def test_health_failure_rolls_back(self):
  with patch.object(r,'restart') as restart,patch.object(r,'wait_health',side_effect=[RuntimeError('bad served file'),None]):
   with self.assertRaisesRegex(RuntimeError,'已回滚'):r.deploy(self.archive,'new-release',self.digest)
   self.assertEqual((self.root/'current').resolve(),self.old);self.assertEqual(restart.call_count,2)
 def test_success_keeps_previous(self):
  with patch.object(r,'restart'),patch.object(r,'wait_health'):
   r.deploy(self.archive,'new-release',self.digest)
   self.assertEqual((self.root/'current').resolve(),self.root/'releases/new-release');self.assertTrue(self.old.exists())
 def test_no_restart_activates_release_for_manual_restart(self):
  with patch.object(r,'restart') as restart,patch.object(r,'wait_health') as health:
   r.deploy(self.archive,'manual-restart-release',self.digest,restart_service=False)
   restart.assert_not_called();health.assert_not_called()
   self.assertEqual((self.root/'current').resolve(),self.root/'releases/manual-restart-release')
 def test_bad_manifest_never_switches(self):
  with patch.object(r,'restart') as restart:
   with self.assertRaisesRegex(RuntimeError,'清单'):r.deploy(self.archive,'new-release','bad')
   restart.assert_not_called();self.assertEqual((self.root/'current').resolve(),self.old)

unittest.main()
