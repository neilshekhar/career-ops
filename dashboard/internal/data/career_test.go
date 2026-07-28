package data

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestUpdateApplicationStatusDelegatesToCanonicalWriter(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("failed to create data dir: %v", err)
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 7 | 2026-06-23 | Applied Materials | Staff Android Engineer | 4.2/5 | Applied | ✅ | [7](reports/007.md) | substring trap |
`
	if err := os.WriteFile(filepath.Join(dataDir, "applications.md"), []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write tracker: %v", err)
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 1 {
		t.Fatalf("expected 1 parsed application, got %d", len(apps))
	}

	originalWriter := canonicalStatusWriter
	defer func() { canonicalStatusWriter = originalWriter }()
	var gotRoot string
	var gotArgs []string
	canonicalStatusWriter = func(root string, args ...string) ([]byte, error) {
		gotRoot = root
		gotArgs = append([]string(nil), args...)
		return []byte(`{"changed":true}`), nil
	}

	if err := UpdateApplicationStatus(tempDir, apps[0], "Interview"); err != nil {
		t.Fatalf("UpdateApplicationStatus: %v", err)
	}
	if gotRoot != tempDir {
		t.Fatalf("writer root = %q, want %q", gotRoot, tempDir)
	}
	wantArgs := []string{"7", "Interview", "--external", "--json"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Fatalf("writer args = %#v, want %#v", gotArgs, wantArgs)
	}
}

func TestParseApplicationsUsesTrackerNumberColumn(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("failed to create data dir: %v", err)
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 140 | 2026-04-16 | Arize AI | AI Engineer, Instrumentation | 4.7/5 | Evaluated | ✅ | [140](reports/140-arize-ai-engineer-instrumentation-2026-04-16.md) | Strong fit |
| 143 | 2026-04-16 | Arize AI | AI Sales Engineer, US | 4.1/5 | Evaluated | ❌ | [143](reports/143-arize-ai-sales-engineer-us-2026-04-16.md) | Good fit |
`

	applicationsPath := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(applicationsPath, []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications tracker: %v", err)
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 2 {
		t.Fatalf("expected 2 parsed applications, got %d", len(apps))
	}

	if apps[0].Number != 140 {
		t.Fatalf("expected first application number to be 140, got %d", apps[0].Number)
	}
	if apps[1].Number != 143 {
		t.Fatalf("expected second application number to be 143, got %d", apps[1].Number)
	}
	if apps[0].ReportNumber != "140" || apps[1].ReportNumber != "143" {
		t.Fatalf("expected report numbers to stay aligned with tracker IDs, got %q and %q", apps[0].ReportNumber, apps[1].ReportNumber)
	}
}

func TestParseApplicationsResolvesTrackerRelativeReportLinks(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	reportsDir := filepath.Join(tempDir, "reports")
	for _, dir := range []string{dataDir, reportsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("failed to create dir %s: %v", dir, err)
		}
	}

	// Tracker links are written relative to the tracker file itself
	// (merge-tracker.mjs normalization): ../reports/... when the tracker
	// lives under data/. Legacy trackers may still carry root-relative
	// links; both must resolve to the same on-disk report.
	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-03 | Acme | Engineer | 4.0/5 | Evaluated | ✅ | [1](../reports/001-acme-2026-06-03.md) | Tracker-relative link |
| 2 | 2026-06-03 | Legacy Co | Engineer | 3.0/5 | Evaluated | ❌ | [2](reports/002-legacy-2026-06-03.md) | Legacy root-relative link |
`

	if err := os.WriteFile(filepath.Join(dataDir, "applications.md"), []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications tracker: %v", err)
	}
	for _, name := range []string{"001-acme-2026-06-03.md", "002-legacy-2026-06-03.md"} {
		if err := os.WriteFile(filepath.Join(reportsDir, name), []byte("# Report\n"), 0o644); err != nil {
			t.Fatalf("failed to write report %s: %v", name, err)
		}
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 2 {
		t.Fatalf("expected 2 parsed applications, got %d", len(apps))
	}

	wantFirst := filepath.Join("reports", "001-acme-2026-06-03.md")
	if apps[0].ReportPath != wantFirst {
		t.Fatalf("expected tracker-relative link to resolve to %q, got %q", wantFirst, apps[0].ReportPath)
	}
	wantSecond := filepath.Join("reports", "002-legacy-2026-06-03.md")
	if apps[1].ReportPath != wantSecond {
		t.Fatalf("expected legacy root-relative link to resolve to %q, got %q", wantSecond, apps[1].ReportPath)
	}

	// Every consumer joins ReportPath against careerOpsPath — both rows
	// must point at files that exist.
	for i, app := range apps {
		if _, err := os.Stat(filepath.Join(tempDir, app.ReportPath)); err != nil {
			t.Fatalf("row %d: resolved report path %q does not exist: %v", i, app.ReportPath, err)
		}
	}
}

// writeTracker writes applications.md under data/ and returns the temp root and
// the tracker path.
func writeTracker(t *testing.T, body string) (string, string) {
	t.Helper()
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write tracker: %v", err)
	}
	return tempDir, path
}

const insertedColumnTracker = `# Applications Tracker

| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |
|---|------|---------|------|----------|-------|--------|-----|--------|-------|
| 1 | 2026-06-01 | Acme | VP Marketing | Remote | 4.5/5 | Applied | ✅ | [1](reports/001.md) | hot lead |
`

// A tracker with a Location column inserted before Score (the customized layout
// the Node tracker tooling supports since #954) must not desync the Go reader.
// Without header-aware mapping, Status reads the Score cell and the report link
// reads the PDF cell, so ReportNumber comes back empty.
func TestParseApplicationsMapsColumnsByHeader(t *testing.T) {
	tempDir, _ := writeTracker(t, insertedColumnTracker)

	apps := ParseApplications(tempDir)
	if len(apps) != 1 {
		t.Fatalf("expected 1 application, got %d", len(apps))
	}
	a := apps[0]
	if a.Company != "Acme" {
		t.Errorf("Company = %q, want \"Acme\"", a.Company)
	}
	if a.Role != "VP Marketing" {
		t.Errorf("Role = %q, want \"VP Marketing\"", a.Role)
	}
	if a.Status != "Applied" {
		t.Errorf("Status = %q, want \"Applied\"", a.Status)
	}
	if a.ScoreRaw != "4.5/5" {
		t.Errorf("ScoreRaw = %q, want \"4.5/5\"", a.ScoreRaw)
	}
	if !a.HasPDF {
		t.Errorf("HasPDF = false, want true")
	}
	if a.ReportNumber != "1" {
		t.Errorf("ReportNumber = %q, want \"1\"", a.ReportNumber)
	}
}

func TestGenericTrackerTransitionsCannotCreateApplicationEvidence(t *testing.T) {
	for _, target := range []string{"Applied", "Responded", "Interview", "Offer", "Hired", "Rejected"} {
		if err := validateTrackerStatusTransition("Evaluated", target); err == nil {
			t.Errorf("Evaluated -> %s unexpectedly allowed", target)
		}
	}
	if err := validateTrackerStatusTransition("Applied", "Applied"); err == nil {
		t.Error("generic tracker control unexpectedly allowed Applied")
	}
	if err := validateTrackerStatusTransition("Applied", "Interview"); err != nil {
		t.Fatalf("receipt-proven prior application should allow an external Interview outcome: %v", err)
	}
	for _, option := range AllowedTrackerStatusTransitions("Evaluated") {
		if NormalizeStatus(option) == "applied" {
			t.Fatalf("pre-application picker exposed Applied: %#v", AllowedTrackerStatusTransitions("Evaluated"))
		}
	}
	queueOnly := map[string]bool{"saved": true, "scored": true, "prepared": true, "prefilled": true, "filled": true}
	for _, current := range []string{"Evaluated", "Applied", "Responded", "Interview", "Offer", "Hired", "Rejected", "Discarded", "SKIP"} {
		for _, option := range AllowedTrackerStatusTransitions(current) {
			if queueOnly[NormalizeStatus(option)] {
				t.Fatalf("tracker picker leaked queue-only state %q from %s", option, current)
			}
		}
	}
}

// resolveTrackerColumns detects the header layout, and falls back to the legacy
// fixed layout when no recognizable header row is present.
func TestResolveTrackerColumns(t *testing.T) {
	header := strings.Split(insertedColumnTracker, "\n")
	cols := resolveTrackerColumns(header)
	if cols["status"] != 6 {
		t.Errorf("status index = %d, want 6 (inserted Location column)", cols["status"])
	}
	if cols["score"] != 5 {
		t.Errorf("score index = %d, want 5", cols["score"])
	}

	headerless := []string{"| 1 | 2026-06-01 | Acme | VP Marketing | 4.5/5 | Applied | ✅ | [1](reports/001.md) | note |"}
	fallback := resolveTrackerColumns(headerless)
	if fallback["status"] != 5 {
		t.Errorf("fallback status index = %d, want 5 (legacy layout)", fallback["status"])
	}
}

// A duplicated header name resolves to its LAST occurrence, matching
// detectColumns in tracker-parse.mjs — the JS and Go readers must map an
// identical header row identically.
func TestResolveTrackerColumnsDuplicateHeaderLastWins(t *testing.T) {
	dup := strings.Split(`| # | Notes | Company | Role | Score | Status | PDF | Report | Notes |
|---|-------|---------|------|-------|--------|-----|--------|-------|
| 1 | stray | Acme | Engineer | 4.0/5 | Applied | ✅ | — | real note |`, "\n")
	cols := resolveTrackerColumns(dup)
	// Verify that the last "Notes" column wins
	if cols["notes"] != 8 {
		t.Fatalf("notes index = %d, expected 8 (tracker-parse.mjs parity)", cols["notes"])
	}
}

// A Via column (intermediary channel, #1596) between Company and Role maps by
// header name; later columns keep their correct indices.
func TestResolveTrackerColumnsVia(t *testing.T) {
	viaTracker := strings.Split(`| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|-----|------|-------|--------|-----|--------|-------|
| 1 | 2026-01-05 | ? | Hays | Data Engineer | 4.2/5 | Applied | ✅ | — | fintech, Leeds |`, "\n")
	cols := resolveTrackerColumns(viaTracker)
	if cols["via"] != 3 {
		t.Errorf("via index = %d, want 3", cols["via"])
	}
	if cols["role"] != 4 {
		t.Errorf("role index = %d, want 4 (shifted by Via column)", cols["role"])
	}
	if cols["status"] != 6 {
		t.Errorf("status index = %d, want 6", cols["status"])
	}
}

// TestNormalizeStatus verifies that localized string variants map to the canonical English form.
func TestNormalizeStatus(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		// Turkish status strings
		{"değerlendirildi", "evaluated"},
		{"Değerlendirildi", "evaluated"},
		{"DEĞERLENDİRİLDİ", "evaluated"},
		{"başvuruldu", "applied"},
		{"Başvuruldu", "applied"},
		{"BAŞVURULDU", "applied"},
		{"yanıt verildi", "responded"},
		{"yanıt_verildi", "responded"},
		{"YANIT VERİLDİ", "responded"},
		{"mülakat", "interview"},
		{"Mülakat", "interview"},
		{"MÜLAKAT", "interview"},
		{"teklif", "offer"},
		{"Teklif", "offer"},
		{"TEKLİF", "offer"},
		{"reddedildi", "rejected"},
		{"Reddedildi", "rejected"},
		{"REDDEDİLDİ", "rejected"},
		{"iptal edildi", "discarded"},
		{"iptal_edildi", "discarded"},
		{"İPTAL EDİLDİ", "discarded"},
		{"uygun değil", "skip"},
		{"uygun_değil", "skip"},
		{"UYGUN DEĞİL", "skip"},

		// No-diacritic variants
		{"degerlendirildi", "evaluated"},
		{"DEGERLENDIRILDI", "evaluated"},
		{"basvuruldu", "applied"},
		{"BASVURULDU", "applied"},
		{"yanit verildi", "responded"},
		{"mulakat", "interview"},
		{"uygun degil", "skip"},

		// English status strings
		{"Evaluated", "evaluated"},
		{"Applied", "applied"},
		{"Responded", "responded"},
		{"Interview", "interview"},
		{"Offer", "offer"},
		{"Rejected", "rejected"},
		{"Discarded", "discarded"},
		{"SKIP", "skip"},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.input, func(t *testing.T) {
			t.Parallel()
			if got := NormalizeStatus(tt.input); got != tt.want {
				t.Errorf("NormalizeStatus(%q) = %q; want %q", tt.input, got, tt.want)
			}
		})
	}
}

// Regression: when an external writer (set-status.mjs, merge-tracker.mjs,
// another session) changes a row's status while the dashboard is open, the
// in-memory "old" status no longer matches the file. The update must still
// land in the Status column — identified via the header — rather than
// silently no-opping.
func TestUpdateApplicationStatusWithStaleInMemoryStatus(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	applications := `# Applications Tracker

| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|-----|------|-------|--------|-----|--------|-------|
| 28 | 2026-07-10 | ? | DaCodes | Backend Engineer | 3.1/5 | Applied | ✅ | [28](../reports/028-dacodes.md) | note |
`
	path := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(path, []byte(applications), 0o644); err != nil {
		t.Fatalf("write tracker: %v", err)
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 1 {
		t.Fatalf("expected 1 app, got %d", len(apps))
	}

	// Simulate an external writer changing the status on disk after parse.
	stale := strings.Replace(applications, "| Applied |", "| Responded |", 1)
	if err := os.WriteFile(path, []byte(stale), 0o644); err != nil {
		t.Fatalf("rewrite tracker: %v", err)
	}

	// apps[0].Status is still "Applied" (stale). The dashboard must delegate
	// by stable tracker number; the canonical writer owns the fresh disk read.
	originalWriter := canonicalStatusWriter
	defer func() { canonicalStatusWriter = originalWriter }()
	canonicalStatusWriter = func(root string, args ...string) ([]byte, error) {
		current, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if !strings.Contains(string(current), "| Responded |") {
			return nil, errors.New("canonical writer did not observe the fresh on-disk state")
		}
		updated := strings.Replace(string(current), "| Responded |", "| Interview |", 1)
		if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
			return nil, err
		}
		return []byte(`{"changed":true}`), nil
	}
	if err := UpdateApplicationStatus(tempDir, apps[0], "Interview"); err != nil {
		t.Fatalf("UpdateApplicationStatus with stale status: %v", err)
	}

	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !strings.Contains(string(out), "| Interview |") {
		t.Errorf("status not updated, file now:\n%s", string(out))
	}
	if strings.Contains(string(out), "| Responded |") || strings.Contains(string(out), "| Applied |") {
		t.Errorf("old status still present, file now:\n%s", string(out))
	}
}

// Canonical-writer failures must surface without the dashboard attempting a
// second, direct tracker mutation.
func TestUpdateApplicationStatusPropagatesCanonicalWriterRefusal(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 3 | 2026-07-10 | Acme | Engineer | 3.1/5 | Evaluated | ✅ | [3](reports/003.md) | note |
`
	path := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(path, []byte(applications), 0o644); err != nil {
		t.Fatalf("write tracker: %v", err)
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 1 {
		t.Fatalf("expected 1 app, got %d", len(apps))
	}

	// Corrupt the status cell into something that is not a status.
	broken := strings.Replace(applications, "| Evaluated |", "| ??? |", 1)
	if err := os.WriteFile(path, []byte(broken), 0o644); err != nil {
		t.Fatalf("rewrite tracker: %v", err)
	}

	originalWriter := canonicalStatusWriter
	defer func() { canonicalStatusWriter = originalWriter }()
	canonicalStatusWriter = func(_ string, _ ...string) ([]byte, error) {
		return []byte(`{"error":"unrecognizable current status"}`), errors.New("exit status 1")
	}

	if err := UpdateApplicationStatus(tempDir, apps[0], "Discarded"); err == nil {
		t.Fatal("expected an error when the status cell is unrecognizable, got nil")
	} else if !strings.Contains(err.Error(), "unrecognizable current status") {
		t.Fatalf("canonical writer detail was not propagated: %v", err)
	}

	out, _ := os.ReadFile(path)
	if !strings.Contains(string(out), "| ??? |") {
		t.Errorf("file was modified despite refusal, now:\n%s", string(out))
	}
}
