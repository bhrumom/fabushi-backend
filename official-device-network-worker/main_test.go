package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
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
		Frame:      `{"type":"describeTool","toolName":"Computer"}` + "\n",
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

func TestValidateRequestRejectsFrameIdentityMismatch(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	cases := []struct {
		name   string
		mutate func(*workerRequest)
	}{
		{
			name: "device id",
			mutate: func(req *workerRequest) {
				req.Frame = strings.Replace(req.Frame, "\"deviceId\":\"device-fdn-1\"", "\"deviceId\":\"device-fdn-2\"", 1)
			},
		},
		{
			name: "network generation",
			mutate: func(req *workerRequest) {
				req.Frame = strings.Replace(req.Frame, "\"networkGeneration\":17", "\"networkGeneration\":18", 1)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := validRequest()
			tc.mutate(&req)
			if err := validateRequest(req, "cell-fdn-account-a", defaultTargetPort, now); err == nil {
				t.Fatal("mismatched target frame identity was accepted")
			}
		})
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
		_, _ = io.WriteString(server, `{"type":"toolDescription","available":false}`+"\n")
	}()

	result, dispatchState, err := dispatchPrivateRequest(context.Background(), dial, req, defaultTargetPort)
	if err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}
	if dispatchState != "completed" {
		t.Fatalf("unexpected dispatch state %q", dispatchState)
	}
	var decoded map[string]any
	if err := json.Unmarshal(result, &decoded); err != nil {
		t.Fatalf("result JSON invalid: %v", err)
	}
	if decoded["type"] != "toolDescription" {
		t.Fatalf("unexpected result %#v", decoded)
	}
}

func TestDispatchDialFailureIsExplicitlyNotDispatched(t *testing.T) {
	req := validRequest()
	_, state, err := dispatchPrivateRequest(context.Background(), func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("offline")
	}, req, defaultTargetPort)
	if err == nil || state != "not_dispatched" {
		t.Fatalf("expected safe pre-dispatch failure, state=%q err=%v", state, err)
	}
}

func TestHTTPHandlerReturnsCorrelatedPreDispatchFailure(t *testing.T) {
	req := validRequest()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	dial := func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("offline")
	}
	httpReq := httptest.NewRequest(http.MethodPost, privateRequestPath, strings.NewReader(string(body)))
	recorder := httptest.NewRecorder()
	handler("cell-fdn-account-a", "100.64.0.2", defaultTargetPort, dial, func() time.Time {
		return time.Unix(1_800_000_000, 0)
	}).ServeHTTP(recorder, httpReq)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 for not-dispatched request, got %d", recorder.Code)
	}
	var response workerResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("response JSON invalid: %v", err)
	}
	if response.OK || response.DispatchState != "not_dispatched" ||
		response.RequestID != req.RequestID || response.DeviceID != req.DeviceID ||
		response.NodeID != req.NodeID || response.Generation != req.Generation {
		t.Fatalf("unexpected pre-dispatch response: %#v", response)
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
	handler("cell-fdn-account-a", "100.64.0.2", defaultTargetPort, dial, func() time.Time {
		return time.Unix(1_800_000_000, 0)
	}).ServeHTTP(recorder, httpReq)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", recorder.Code)
	}
	if dials != 0 {
		t.Fatalf("unexpected dial count %d", dials)
	}
}

func TestPreferredSelfNodePrefersTailnetIPv4AndRejectsPublicOnly(t *testing.T) {
	ips := []netip.Addr{
		netip.MustParseAddr("fd7a:115c:a1e0::12"),
		netip.MustParseAddr("100.64.0.22"),
	}
	node, ok := preferredSelfNode(ips)
	if !ok || node != "100.64.0.22" {
		t.Fatalf("unexpected preferred node %q ok=%v", node, ok)
	}
	if _, ok := preferredSelfNode([]netip.Addr{netip.MustParseAddr("8.8.8.8")}); ok {
		t.Fatal("public address unexpectedly accepted as self node")
	}
}

func TestStatusSurfaceIsLoopbackMetadataOnlyAndDoesNotDial(t *testing.T) {
	dials := 0
	dial := func(context.Context, string, string) (net.Conn, error) {
		dials++
		return nil, io.EOF
	}
	httpReq := httptest.NewRequest(http.MethodGet, statusPath, nil)
	recorder := httptest.NewRecorder()
	handler("cell-fdn-account-a", "100.64.0.22", defaultTargetPort, dial, time.Now).
		ServeHTTP(recorder, httpReq)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}
	var status map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &status); err != nil {
		t.Fatalf("status JSON invalid: %v", err)
	}
	if len(status) != 3 || status["cellId"] != "cell-fdn-account-a" ||
		status["nodeId"] != "100.64.0.22" || status["ready"] != true {
		t.Fatalf("unexpected status %#v", status)
	}
	for _, forbidden := range []string{"authKey", "controlUrl", "stateDir", "hostname", "token", "secret"} {
		if strings.Contains(recorder.Body.String(), forbidden) {
			t.Fatalf("status leaked forbidden field %q: %s", forbidden, recorder.Body.String())
		}
	}
	if dials != 0 {
		t.Fatalf("status unexpectedly dialed %d times", dials)
	}

	for _, rawURL := range []string{statusPath + "?debug=1", privateRequestPath} {
		req := httptest.NewRequest(http.MethodGet, rawURL, nil)
		out := httptest.NewRecorder()
		handler("cell-fdn-account-a", "100.64.0.22", defaultTargetPort, dial, time.Now).
			ServeHTTP(out, req)
		if out.Code != http.StatusNotFound {
			t.Fatalf("unexpected GET acceptance for %s: %d", rawURL, out.Code)
		}
	}
}
