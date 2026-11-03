"""Refresh licensed analytics and publish health without changing last-good data."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

root=Path(__file__).resolve().parent
# Temporary downloads never become public site assets. The updater retains dated
# national history from analysis.json when no newer captured history is supplied.
with tempfile.TemporaryDirectory(prefix='midterm-analysis-') as cache:
    run=subprocess.run([sys.executable,str(root/'update_analysis.py'),'--source-dir',cache,'--catalog',str(root/'data.json'),'--output',str(root/'analysis.json'),'--fetch','--allow-stale'],capture_output=True,text=True,encoding='utf-8')
try:
    result=json.loads(run.stdout.strip().splitlines()[-1])
except (ValueError,IndexError):
    sys.stderr.write(run.stderr)
    raise SystemExit(run.returncode or 1)
health=result.get('updateHealth',{})
(root/'analysis-health.json').write_text(json.dumps(health,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result))
raise SystemExit(run.returncode)
