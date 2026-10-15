import importlib.util
import struct
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('fdn-public-network-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class StunBoundary(unittest.TestCase):
    transaction = b'0123456789ab'
    source = (probe.IP, 3478)

    def packet(self, attrs=None):
        if attrs is None:
            attrs = struct.pack('!HHBBHI', 0x20, 8, 0, 1, 12345 ^ (probe.COOKIE >> 16), 0x08080808 ^ probe.COOKIE)
        return struct.pack('!HHI', 0x101, len(attrs), probe.COOKIE) + self.transaction + attrs

    def test_valid_xor_mapping(self):
        self.assertTrue(probe.mapped_response(self.packet(), self.transaction, self.source))

    def test_wrong_source_or_transaction_or_cookie(self):
        for packet, transaction, source in [(self.packet(), self.transaction, ('127.0.0.1', 3478)),
                                             (self.packet(), b'other-trans!', self.source),
                                             (self.packet()[:4] + b'bad!' + self.packet()[8:], self.transaction, self.source)]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                probe.mapped_response(packet, transaction, source)

    def test_truncated_attribute_and_header(self):
        for packet in [b'', self.packet()[:-1], self.packet(struct.pack('!HH', 0x20, 32))]:
            with self.subTest(length=len(packet)), self.assertRaises(ValueError):
                probe.mapped_response(packet, self.transaction, self.source)

    def test_absent_or_nonpublic_mapping(self):
        for attrs in [b'', struct.pack('!HHBBHI', 1, 8, 0, 1, 12345, 0x7f000001),
                      struct.pack('!HHBBHI', 1, 8, 0, 1, 0, 0x08080808)]:
            with self.subTest(size=len(attrs)), self.assertRaises(ValueError):
                probe.mapped_response(self.packet(attrs), self.transaction, self.source)


if __name__ == '__main__':
    unittest.main()
