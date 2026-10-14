package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func validRequest() workerRequest {
	return workerRequest{
		RequestID:  "0123456789abcdef0123456789abcdef",
		AccountID:  "user:fdn",
		DeviceID:   "device-fdn-1",
		CellID:     "cell-fdn-account-a",
		NodeID:     "100.64.0.10",
		Generation: 17,
		ExpiresAt:  4_000_000_000,
		TargetPort: defaultTargetPort,
		TimeoutMS:  5000,
		Frame:      "{"type":"describeTool","toolName":"Computer"}\n",
	}
}

func TestValidateRequestFencesCellPeerPortExpiryAndFrame(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	req := validRequest()
	if err := validateRequest(req, "cell-fdn-account-a", defaultTargetPort, now); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}

	cases := []workerRequest{
		func() workerRequest { v := req; v.CellID = "cell-other-account"; return v }(),
		func() workerRequest { v := req; v.NodeID = "8.8.8.8"; return v }(),
		func() workerRequest { v := req; v.TargetPort = 22; return v }(),
		func() workerRequest { v := req; v.ExpiresAt = now.Unix(); return v }(),
		func() workerRequest { v := req; v.Frame = "{}\n{}\n"; return v }(),
	}
	for i, candidate := range cases {
		if err := validateRequest(candidate, "cell-fdn-account-a", defaultTargetPort, now); err == nil {
			t.Fatalf("case %d unexpectedly accepted", i)
		}
	}
}

func TestDispatchWritesOneFrameAndReadsOneCorrelatedJSONResult(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	req := validRequest()
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" {
			t.Fatalf("unexpected network %s", network)
		}
		if address != "100.64.0.10:8792" {
			t.Fatalf("unexpected address %s", address)
		}
		return client, nil
	}
	go func() {
		frame, err := io.ReadAll(io.LimitReader(server, int64(len(req.Frame))))
		if err != nil {
			return
		}
		if string(frame) != req.Frame {
			return
		}
		_, _ = io.WriteString(server, "{"type":"toolDescription","available":false}\n")
	}()

	result, err := dispatchPrivateRequest(context.Background(), dial, req, defaultTargetPort)
	if err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(result, &decoded); err != nil {
		t.Fatalf("result JSON invalid: %v", err)
	}
	if decoded["type"] != "toolDescription" {
		t.Fatalf("unexpected result %#v", decoded)
	}
}

func TestHTTPHandlerRejectsUnknownFieldsBeforeDial(t *testing.T) {
	dials := 0
	dial := func(context.Context, string, string) (net.Conn, error) {
		dials++
		return nil, io.EOF
	}
	req := validRequest()
	body, _ := json.Marshal(map[string]any{
		"requestId":    req.RequestID,
		"accountId":    req.AccountID,
		"deviceId":     req.DeviceID,
		"cellId":       req.CellID,
		"nodeId":       req.NodeID,
		"generation":   req.Generation,
		"expiresAt":    req.ExpiresAt,
		"targetPort":   req.TargetPort,
		"timeoutMs":    req.TimeoutMS,
		"frame":        req.Frame,
		"deviceSecret": "must-not-be-accepted",
	})
	httpReq := httptest.NewRequest(http.MethodPost, privateRequestPath, strings.NewReader(string(body)))
	recorder := httptest.NewRecorder()
	handler("cell-fdn-account-a", defaultTargetPort, dial, func() time.Time {
		return time.Unix(1_800_000_000, 0)
	}).ServeHTTP(recorder, httpReq)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", recorder.Code)
	}
	if dials != 0 {
		t.Fatalf("unexpected dial count %d", dials)
	}
}
