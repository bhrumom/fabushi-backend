"""Read-only external infrastructure probe; execution is Actions-only."""
import binascii
import ipaddress
import json
import os
import secrets
import socket
import struct
import time
import urllib.error
import urllib.request
from pathlib import Path

HOST = 'fdn.ombhrum.com'
IP = '144.24.17.21'
COOKIE = 0x2112A442


def binding_request(transaction):
    if len(transaction) != 12:
        raise ValueError('stun_transaction_invalid')
    # Tailscale's pinned server intentionally accepts its SOFTWARE marker only.
    prefix = struct.pack('!HHI', 1, 20, COOKIE) + transaction
    prefix += struct.pack('!HH', 0x8022, 8) + b'tailnode'
    fingerprint = binascii.crc32(prefix) ^ 0x5354554e
    return prefix + struct.pack('!HHI', 0x8028, 4, fingerprint)


def mapped_response(packet, transaction, source):
    if source != (IP, 3478):
        raise ValueError('stun_source_mismatch')
    if len(packet) < 20 or len(packet) > 4096:
        raise ValueError('stun_length_invalid')
    kind, size, cookie = struct.unpack('!HHI', packet[:8])
    if kind != 0x0101 or cookie != COOKIE or packet[8:20] != transaction:
        raise ValueError('stun_identity_invalid')
    if size % 4 or size != len(packet) - 20:
        raise ValueError('stun_length_invalid')
    offset, found = 20, False
    while offset < len(packet):
        if offset + 4 > len(packet):
            raise ValueError('stun_attribute_invalid')
        tag, size = struct.unpack('!HH', packet[offset:offset + 4])
        end = offset + 4 + size
        padded = offset + 4 + ((size + 3) // 4) * 4
        if end > len(packet) or padded > len(packet):
            raise ValueError('stun_attribute_invalid')
        value = packet[offset + 4:end]
        if tag in (0x0001, 0x0020):
            family = value[1] if len(value) >= 4 else 0
            if value[:1] != b'\x00' or family not in (1, 2) or len(value) != (8 if family == 1 else 20):
                raise ValueError('stun_mapping_invalid')
            port = struct.unpack('!H', value[2:4])[0]
            encoded = value[4:]
            if tag == 0x0020:
                port ^= COOKIE >> 16
                mask = struct.pack('!I', COOKIE) + transaction
                encoded = bytes(a ^ b for a, b in zip(encoded, mask))
            address = ipaddress.ip_address(encoded)
            if isinstance(address, ipaddress.IPv6Address):
                address = address.ipv4_mapped
            if not port or not isinstance(address, ipaddress.IPv4Address) or not address.is_global:
                raise ValueError('stun_mapping_invalid')
            found = True
        offset = padded
    if not found:
        raise ValueError('stun_mapping_missing')
    return True


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise SystemExit('actions_only')
    sha = os.environ.get('GITHUB_SHA', '')
    if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
        raise SystemExit('invalid_source')
    report = {'backendSha': sha, 'runId': os.environ.get('GITHUB_RUN_ID'),
              'environment': 'github-hosted-ubuntu', 'scope': 'public-infrastructure-only',
              'status': 'FAIL', 'assertions': [], 'exitCode': 1}

    def record(name, action):
        started = time.monotonic()
        action()
        report['assertions'].append({'name': name, 'status': 'PASS',
                                     'elapsedMs': round((time.monotonic() - started) * 1000)})

    try:
        def dns():
            addresses = {x[4][0] for x in socket.getaddrinfo(HOST, 3478, socket.AF_INET, socket.SOCK_DGRAM)}
            if addresses != {IP}:
                raise ValueError('dns_destination_mismatch')
        record('dnsExactDestination', dns)
        opener = urllib.request.build_opener(NoRedirect)

        def http(path, expected):
            try:
                with opener.open('https://' + HOST + path, timeout=15) as response:
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code
                error.close()
            if status != expected:
                raise ValueError('http_status_mismatch')

        record('tlsHealth', lambda: http('/health', 200))
        record('derpLatencyEndpoint', lambda: http('/derp/probe', 200))
        for path in ['/metrics', '/api/v1/node', '/swagger', '/debug']:
            record('adminDenied:' + path, lambda path=path: http(path, 403))

        def stun():
            transaction = secrets.token_bytes(12)
            packet = binding_request(transaction)
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(8)
                sock.sendto(packet, (IP, 3478))
                response, source = sock.recvfrom(4097)
            mapped_response(response, transaction, source)
        record('externalStunBinding', stun)
        report.update(status='PASS', exitCode=0)
    except (ValueError, OSError, urllib.error.URLError) as error:
        allowed = {'stun_source_mismatch', 'stun_length_invalid', 'stun_identity_invalid',
                   'stun_attribute_invalid', 'stun_mapping_invalid', 'stun_mapping_missing',
                   'dns_destination_mismatch', 'http_status_mismatch'}
        report['failure'] = str(error) if str(error) in allowed else 'network_unavailable'
    finally:
        report['passed'] = len(report['assertions'])
        report['required'] = 8
        report['skipped'] = 0
        Path('evidence').mkdir(exist_ok=True)
        Path('evidence/fdn-public-network.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report))
    raise SystemExit(report['exitCode'])


if __name__ == '__main__':
    main()
