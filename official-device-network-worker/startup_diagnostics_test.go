package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"syscall"
	"testing"
)

func TestStartupFailureDoesNotDiscloseUpstreamSecrets(t *testing.T) {
	for _, row := range []struct {
		err      error
		category string
	}{
		{syscall.EAFNOSUPPORT, "address-family"}, {syscall.EACCES, "filesystem-permission"},
		{syscall.EROFS, "filesystem-permission"}, {syscall.EPERM, "network-permission"},
		{context.DeadlineExceeded, "timeout"}, {errors.New("secret-credential https://private.invalid"), "unknown"},
	} {
		if got := startupFailureCategory(fmt.Errorf("secret-credential: %w", row.err)); got != row.category {
			t.Fatalf("category=%q want=%q", got, row.category)
		}
	}
}

func TestStartupFailureCategoryPreservesSafeCategoriesFromTailscaleStateMessages(t *testing.T) {
	for _, row := range []struct {
		name     string
		err      error
		category string
	}{
		{name: "state message EACCES", err: errors.New("tsnet.Up: backend: open state: permission denied: https://private.invalid?token=secret"), category: "filesystem-permission"},
		{name: "state message EROFS", err: errors.New("tsnet.Up: backend: write state: read-only file system"), category: "filesystem-permission"},
		{name: "state message EAFNOSUPPORT", err: errors.New("tsnet.Up: backend: address family not supported by protocol"), category: "address-family"},
		{name: "state message EPERM", err: errors.New("tsnet.Up: backend: operation not permitted"), category: "network-permission"},
		{name: "state message timeout", err: errors.New("tsnet.Up: backend: operation timed out"), category: "timeout"},
		{name: "expired enrollment key", err: errors.New("tsnet.Up: backend: authkey expired"), category: "authentication"},
		{name: "unknown does not disclose message", err: errors.New("credential=secret callback=https://private.invalid"), category: "unknown"},
	} {
		t.Run(row.name, func(t *testing.T) {
			got := startupFailureCategory(row.err)
			if got != row.category {
				t.Fatalf("category=%q want=%q", got, row.category)
			}
			if strings.Contains(got, "secret") || strings.Contains(got, "private.invalid") || strings.Contains(got, "credential") {
				t.Fatalf("unsafe category output %q", got)
			}
		})
	}
}
