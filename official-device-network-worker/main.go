package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"tailscale.com/envknob"
	"tailscale.com/tsnet"
)

const (
	privateRequestPath  = "/v1/fdn/private-request"
	defaultBind         = "127.0.0.1:8791"
	defaultTargetPort   = 8792
	maxRequestBytes     = 64 * 1024
	maxTargetFrameBytes = 32 * 1024
	maxResultBytes      = 1024 * 1024
	minTimeoutMS        = 1000
	maxTimeoutMS        = 600000
)

var (
	tailscaleV4 = netip.MustParsePrefix("100.64.0.0/10")
	tailscaleV6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")
)

type workerRequest struct {
	RequestID  string `json:"requestId"`
	AccountID  string `json:"accountId"`
	DeviceID   string `json:"deviceId"`
	CellID     string `json:"cellId"`
	NodeID     string `json:"nodeId"`
	Generation int64  `json:"generation"`
	ExpiresAt  int64  `json:"expiresAt"`
	TargetPort int    `json:"targetPort"`
	TimeoutMS  int    `json:"timeoutMs"`
	Frame      string `json:"frame"`
}

type workerResponse struct {
	RequestID  string          `json:"requestId"`
	DeviceID   string          `json:"deviceId"`
	NodeID     string          `json:"nodeId"`
	Generation int64           `json:"generation"`
	OK         bool            `json:"ok"`
	Result     json.RawMessage `json:"result,omitempty"`
	Error      string          `json:"error,omitempty"`
}

type dialFunc func(context.Context, string, string) (net.Conn, error)

func validID(value string, min, max int) bool {
	value = strings.TrimSpace(value)
	if len(value) < min || len(value) > max {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '.' || r == '_' || r == ':' || r == '-' {
			continue
		}
		return false
	}
	return true
}

func validTailnetPeer(value string) bool {
	addr, err := netip.ParseAddr(strings.TrimSpace(value))
	if err != nil {
		return false
	}
	return tailscaleV4.Contains(addr) || tailscaleV6.Contains(addr)
}

func validateRequest(req workerRequest, expectedCell string, fixedPort int, now time.Time) error {
	if !validID(req.RequestID, 16, 160) || !validID(req.AccountID, 1, 200) ||
		!validID(req.DeviceID, 1, 128) || !validID(req.CellID, 8, 160) ||
		req.CellID != expectedCell || !validTailnetPeer(req.NodeID) ||
		req.Generation <= 0 || req.ExpiresAt <= now.Unix() ||
		req.TargetPort != fixedPort || req.TimeoutMS < minTimeoutMS || req.TimeoutMS > maxTimeoutMS {
		return errors.New("invalid private network request")
	}
	if len(req.Frame) == 0 || len(req.Frame) > maxTargetFrameBytes || !strings.HasSuffix(req.Frame, "\n") {
		return errors.New("invalid target frame")
	}
	if strings.Count(req.Frame, "\n") != 1 {
		return errors.New("target frame must contain exactly one newline terminator")
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSuffix(req.Frame, "\n")), &value); err != nil || len(value) == 0 {
		return errors.New("target frame must be a JSON object")
	}
	return nil
}

func readTargetResult(conn net.Conn, timeout time.Duration) (json.RawMessage, error) {
	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(conn, 32*1024)
	frame, err := reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	if len(frame) == 0 || len(frame) > maxResultBytes+1 {
		return nil, errors.New("target result exceeded bound")
	}
	frame = frame[:len(frame)-1]
	if len(frame) == 0 || !json.Valid(frame) {
		return nil, errors.New("target result was invalid JSON")
	}
	if buffered := reader.Buffered(); buffered > 0 {
		extra, _ := reader.Peek(buffered)
		if strings.TrimSpace(string(extra)) != "" {
			return nil, errors.New("target emitted multiple response frames")
		}
	}
	return json.RawMessage(append([]byte(nil), frame...)), nil
}

func dispatchPrivateRequest(ctx context.Context, dial dialFunc, req workerRequest, fixedPort int) (json.RawMessage, error) {
	address := net.JoinHostPort(req.NodeID, strconv.Itoa(fixedPort))
	conn, err := dial(ctx, "tcp", address)
	if err != nil {
		return nil, errors.New("private peer dial failed")
	}
	defer conn.Close()

	timeout := time.Duration(req.TimeoutMS) * time.Millisecond
	if err := conn.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
		return nil, err
	}
	if _, err := io.WriteString(conn, req.Frame); err != nil {
		return nil, errors.New("private peer write failed")
	}
	return readTargetResult(conn, timeout)
}

func handler(expectedCell string, fixedPort int, dial dialFunc, now func() time.Time) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json; charset=utf-8")
		w.Header().Set("cache-control", "no-store")
		if r.Method != http.MethodPost || r.URL.Path != privateRequestPath || r.URL.RawQuery != "" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		body := http.MaxBytesReader(w, r.Body, maxRequestBytes)
		defer body.Close()
		decoder := json.NewDecoder(body)
		decoder.DisallowUnknownFields()
		var req workerRequest
		if err := decoder.Decode(&req); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		if err := validateRequest(req, expectedCell, fixedPort, now()); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}

		timeout := time.Duration(req.TimeoutMS) * time.Millisecond
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		result, err := dispatchPrivateRequest(ctx, dial, req, fixedPort)
		response := workerResponse{
			RequestID:  req.RequestID,
			DeviceID:   req.DeviceID,
			NodeID:     req.NodeID,
			Generation: req.Generation,
		}
		if err != nil {
			response.OK = false
			response.Error = "private transport failed"
			w.WriteHeader(http.StatusBadGateway)
		} else {
			response.OK = true
			response.Result = result
		}
		_ = json.NewEncoder(w).Encode(response)
	})
}

func requiredEnv(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func main() {
	envknob.SetNoLogsNoSupport()

	expectedCell := requiredEnv("FABUSHI_FDN_WORKER_CELL_ID")
	controlURL := requiredEnv("FABUSHI_FDN_WORKER_CONTROL_URL")
	authKey := requiredEnv("FABUSHI_FDN_WORKER_AUTH_KEY")
	stateDir := requiredEnv("FABUSHI_FDN_WORKER_STATE_DIR")
	hostname := requiredEnv("FABUSHI_FDN_WORKER_HOSTNAME")
	bind := strings.TrimSpace(os.Getenv("FABUSHI_FDN_WORKER_BIND"))
	if bind == "" {
		bind = defaultBind
	}
	host, _, err := net.SplitHostPort(bind)
	if err != nil || host != "127.0.0.1" {
		log.Fatal("FABUSHI_FDN_WORKER_BIND must use 127.0.0.1")
	}
	targetPort := defaultTargetPort
	if raw := strings.TrimSpace(os.Getenv("FABUSHI_FDN_REMOTE_TARGET_PORT")); raw != "" {
		port, parseErr := strconv.Atoi(raw)
		if parseErr != nil || port < 1024 || port > 65535 {
			log.Fatal("FABUSHI_FDN_REMOTE_TARGET_PORT is invalid")
		}
		targetPort = port
	}

	server := &tsnet.Server{
		Dir:          stateDir,
		Hostname:     hostname,
		AuthKey:      authKey,
		ControlURL:   controlURL,
		RunWebClient: false,
		UserLogf: func(string, ...any) {
			log.Print("[fabushi-fdn-network] tsnet state changed")
		},
	}
	authKey = ""
	if err := server.Start(); err != nil {
		log.Fatal("Fabushi FDN network worker failed to start")
	}
	defer server.Close()

	httpServer := &http.Server{
		Addr:              bind,
		Handler:           handler(expectedCell, targetPort, server.Dial, time.Now),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	log.Printf("Fabushi FDN network worker listening on %s for one isolated cell", bind)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "Fabushi FDN network worker stopped unexpectedly")
		os.Exit(1)
	}
}
