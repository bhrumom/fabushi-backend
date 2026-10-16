package main

import (
	"context"
	"errors"
	"fmt"
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
