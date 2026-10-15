"""Actions-only client exercises the actual authenticated server mail API via bounded SSH stdio."""
import json
import os
import subprocess
import shlex

if os.environ.get('GITHUB_ACTIONS') != 'true':
    raise SystemExit('GitHub Actions required')
run = os.environ['GITHUB_RUN_ID']
marker = 'fabushi-production-mail-' + run
body = {'email': 'bhrumom+fabushi-fdn-acceptance-20261015@gmail.com',
        'subject': 'Fabushi production mail verification ' + run,
        'text': 'Production registration mail transport verification. Reference: ' + marker}
token = os.environ['MAIL_API_TOKEN']
if len(token) < 32:
    raise SystemExit('mail API authority missing')
if any(c in token for c in ('\r', '\n')):
    raise SystemExit('invalid mail authority format')
payload = json.dumps(body).encode()
request = ("POST /internal/fabushi-mail/v1/send HTTP/1.0\r\n"
           "Host: localhost\r\nContent-Type: application/json\r\n"
           "Authorization: Bearer " + token + "\r\nContent-Length: " + str(len(payload)) +
           "\r\nConnection: close\r\n\r\n").encode() + payload
# Bounded stdio transport only: existing restricted deployment key need not gain
# SSH port-forwarding capability. Request construction/assertions execute in Actions.
proxy = """import socket,sys
with socket.create_connection(('127.0.0.1',8790),timeout=30) as s:
 s.sendall(sys.stdin.buffer.read(32768))
 s.shutdown(socket.SHUT_WR)
 total=0
 while True:
  data=s.recv(4096)
  if not data: break
  total+=len(data)
  if total>65536: raise SystemExit(64)
  sys.stdout.buffer.write(data)
"""
result = subprocess.run(['ssh', os.environ['DEPLOY_USER'] + '@' + os.environ['DEPLOY_HOST'],
                         'python3 -c ' + shlex.quote(proxy)], input=request,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)
if result.returncode != 0 or len(result.stdout) > 65536:
    raise SystemExit('mail API transport failed')
headers, separator, content = result.stdout.partition(b'\r\n\r\n')
if not separator:
    raise SystemExit('mail API response malformed')
status = int(headers.splitlines()[0].split()[1])
value = json.loads(content)
if status != 200 or value.get('ok') is not True or value.get('provider') != 'bhrum2-postfix':
    raise SystemExit('mail API submission rejected')
with open(os.environ['RUNNER_TEMP'] + '/mail-submission.json', 'w') as f:
    json.dump({'backendSha': os.environ['GITHUB_SHA'], 'runId': run,
               'marker': marker, 'httpStatus': status, 'submissionAccepted': True,
               'mailboxReceiptVerified': False, 'exitCode': 0}, f, indent=2)
print('Authenticated production mail submission accepted; mailbox receipt remains separate.')
