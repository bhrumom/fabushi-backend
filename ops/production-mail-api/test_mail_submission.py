import importlib.util
import pathlib
import subprocess
import unittest
from email import policy
from email.parser import BytesParser
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mail_api', pathlib.Path(__file__).with_name('app.py'))
mail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)

class SubmissionTests(unittest.TestCase):
    def test_envelope_and_header_use_configured_sender(self):
        with patch.object(mail.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')) as run:
            mail.queue_mail('fixture@example.test', 'Fixture', 'Synthetic body')
        args, kwargs = run.call_args
        self.assertEqual(args[0], ['/usr/sbin/sendmail', '-f', mail.MAIL_FROM, '-t', '-i'])
        msg = BytesParser(policy=policy.default).parsebytes(kwargs['input'])
        self.assertEqual(msg['From'].addresses[0].addr_spec, mail.MAIL_FROM)
        self.assertEqual(msg['To'].addresses[0].addr_spec, 'fixture@example.test')
        self.assertEqual(kwargs['timeout'], 20)

    def test_invalid_configured_sender_never_submits(self):
        for value in ['sender@example.test\r\nBcc: leak@example.test', '-x@example.test', 'not-an-email']:
            with self.subTest(value=value), patch.object(mail, 'MAIL_FROM', value), patch.object(mail.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, '^invalid configured sender$'):
                    mail.queue_mail('fixture@example.test', 'Fixture', 'Synthetic body')
                run.assert_not_called()

    def test_submission_error_does_not_expose_stderr(self):
        with patch.object(mail.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'PRIVATE_SMTP_DETAILS')):
            with self.assertRaisesRegex(RuntimeError, '^mail submission failed$'):
                mail.queue_mail('fixture@example.test', 'Fixture', 'Synthetic body')

if __name__ == '__main__':
    unittest.main()
