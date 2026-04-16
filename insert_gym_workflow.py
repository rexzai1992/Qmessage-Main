import json
from pathlib import Path
from urllib import request

base = Path(r"C:\Users\Admin\Desktop\Qmessage-Main")

def read_env(path: Path):
    env = {}
    for line in path.read_text(encoding='utf-8', errors='ignore').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip()
    return env

env = read_env(base / '.env')
workflow = json.loads((base / 'gym-workflow.json').read_text(encoding='utf-8'))
workflow['company_id'] = 'izzul-company'

payload = [{
    'id': workflow['id'],
    'company_id': 'izzul-company',
    'name': workflow.get('name', ''),
    'trigger_keyword': workflow.get('trigger_keyword', ''),
    'run_on_new_chat': workflow.get('run_on_new_chat', False),
    'actions': workflow.get('actions', []),
    'builder': workflow.get('builder'),
    'enabled': workflow.get('enabled', True),
}]

url = env['SUPABASE_URL'].rstrip('/') + '/rest/v1/workflows?on_conflict=id'
req = request.Request(url, data=json.dumps(payload).encode('utf-8'), method='POST')
req.add_header('apikey', env['SUPABASE_SERVICE_ROLE_KEY'])
req.add_header('Authorization', f"Bearer {env['SUPABASE_SERVICE_ROLE_KEY']}")
req.add_header('Content-Type', 'application/json')
req.add_header('Prefer', 'resolution=merge-duplicates,return=representation')

with request.urlopen(req, timeout=30) as resp:
    body = resp.read().decode('utf-8', errors='ignore')
    print(resp.status)
    print(body)
