"""Actions-only client exercises the actual authenticated server mail API via SSH tunnel."""
import json
import os
import urllib.request

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
req = urllib.request.Request('http://127.0.0.1:18790/internal/fabushi-mail/v1/send',
    data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
with urllib.request.urlopen(req, timeout=30) as response:
    status = response.status
    value = json.load(response)
if status != 200 or value.get('ok') is not True or value.get('provider') != 'bhrum2-postfix':
    raise SystemExit('mail API submission rejected')
with open(os.environ['RUNNER_TEMP'] + '/mail-submission.json', 'w') as f:
    json.dump({'backendSha': os.environ['GITHUB_SHA'], 'runId': run,
               'marker': marker, 'httpStatus': status, 'submissionAccepted': True,
               'mailboxReceiptVerified': False, 'exitCode': 0}, f, indent=2)
print('Authenticated production mail submission accepted; mailbox receipt remains separate.')
