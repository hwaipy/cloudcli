import importlib.util
import importlib.machinery
import tempfile
import pathlib
import sys
import unittest
from unittest.mock import patch
loader=importlib.machinery.SourceFileLoader('reload_module',str(pathlib.Path(__file__).resolve().parent.parent / 'reloadCloudCLI'))
spec=importlib.util.spec_from_loader(loader.name,loader)
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;loader.exec_module(m)

class ReloadTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
  self.patches=[patch.object(m,'ROOT',self.root),patch.object(m,'STATE_DIR',self.root/'.debug-local'),patch.object(m,'BUILD_RECEIPT',self.root/'.debug-local/receipt.json')]
  for p in self.patches:p.start()
  (self.root/'server').mkdir();(self.root/'server/a.ts').write_text('first')
  (self.root/'dist-server/server').mkdir(parents=True);(self.root/'dist-server/server/index.js').write_text('old')
  m.TASKS['b'].status='就绪'
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.temp.cleanup()
 def fake_build(self,*args):
  (self.root/'dist-server/server/index.js').write_text((self.root/'server/a.ts').read_text())
 def test_build_then_skip_and_rebuild_on_source_or_output_change(self):
  with patch.object(m,'build_toolchain',return_value=(['node','npm','run','build:server'],{})),patch.object(m,'build_backend',side_effect=self.fake_build) as build,patch.object(m,'run') as restart,patch.object(m,'wait_local_health',return_value='ok'):
   m.restart_backend();self.assertEqual(build.call_count,1)
   m.restart_backend();self.assertEqual(build.call_count,1)
   (self.root/'server/a.ts').write_text('changed');m.restart_backend();self.assertEqual(build.call_count,2)
   (self.root/'server/new.ts').write_text('new');m.restart_backend();self.assertEqual(build.call_count,3)
   (self.root/'server/new.ts').unlink();m.restart_backend();self.assertEqual(build.call_count,4)
   (self.root/'dist-server/server/index.js').write_text('tampered');m.restart_backend();self.assertEqual(build.call_count,5)
   self.assertEqual(restart.call_count,6)
 def test_failure_never_restarts_or_marks_success(self):
  with patch.object(m,'build_toolchain',return_value=(['node'],{})),patch.object(m,'build_backend',side_effect=RuntimeError('compile failed')),patch.object(m,'run') as restart:
   with self.assertRaisesRegex(RuntimeError,'compile failed'):m.restart_backend()
   restart.assert_not_called();self.assertFalse(m.BUILD_RECEIPT.exists())
   self.assertEqual((self.root/'dist-server/server/index.js').read_text(),'old')
 def test_source_changes_during_build_prevent_restart(self):
  def changing(*args):self.fake_build();(self.root/'server/a.ts').write_text('raced')
  with patch.object(m,'build_toolchain',return_value=(['node'],{})),patch.object(m,'build_backend',side_effect=changing),patch.object(m,'run') as restart:
   with self.assertRaisesRegex(RuntimeError,'源码发生变化'):m.restart_backend()
   restart.assert_not_called();self.assertFalse(m.BUILD_RECEIPT.exists())
 def test_compiler_output_is_saved_and_failure_is_clear(self):
  log=self.root/'failure.log'
  with self.assertRaisesRegex(RuntimeError,'error TS1234'):
   m.build_backend([sys.executable,'-c','print("error TS1234: broken source");exit(2)'],dict(m.os.environ),log)
  self.assertIn('broken source',log.read_text())
 def test_timeout_is_reported(self):
  with patch.object(m,'BUILD_TIMEOUT',0.05):
   with self.assertRaisesRegex(RuntimeError,'编译超时'):m.build_backend([sys.executable,'-c','import time;time.sleep(30)'],dict(m.os.environ),self.root/'timeout.log')
 def test_busy_states_block_duplicate_jobs(self):
  for status in m.BUSY_STATUSES:
   m.TASKS['b'].status=status
   with patch.object(m.threading,'Thread') as thread:
    m.start_task('b',[],['']);thread.assert_not_called()

unittest.main()
