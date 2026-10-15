package main

import (
	"bytes"
	"os/exec"
	"testing"

	"tailscale.com/net/stun"
)

func TestPinnedStunProbeRequest(t *testing.T) {
	// Consume the real Python packet generator, then use the shipping pinned
	// Tailscale parser. This would reject the original generic RFC-only probe.
	packet, err := exec.Command("python3", "-c", "import runpy,sys; m=runpy.run_path('../.github/scripts/fdn-public-network-probe.py'); sys.stdout.buffer.write(m['binding_request'](b'0123456789ab'))").Output()
	if err != nil {
		t.Fatal("probe packet generation failed")
	}
	tx, err := stun.ParseBindingRequest(packet)
	if err != nil {
		t.Fatalf("pinned Tailscale rejected actual probe: %v", err)
	}
	if !bytes.Equal(tx[:], []byte("0123456789ab")) {
		t.Fatal("transaction changed")
	}
}
