# Sealed-bid auction on Canton — entry points.
SHELL := /bin/bash
export PATH := $(HOME)/.dpm/bin:$(PATH)
TOPOLOGY ?= config/topology.json
DAR ?= daml/sealed-auction/.daml/dist/sealed-auction-0.1.1.dar
export TOPOLOGY

.PHONY: tools localnet-up localnet-down localnet-clean localnet-reset localnet-status localnet-ps \
        build test-daml test typecheck deploy provision backend e2e demo ui-e2e all

tools:
	@test -x $(HOME)/.dpm/bin/dpm || (curl -fsSL https://get.digitalasset.com/install/install.sh | sh)
	dpm install 3.6.3
	npm install --no-audit --no-fund

localnet-up:     ; scripts/localnet.sh up
localnet-down:   ; scripts/localnet.sh down
localnet-clean:  ; scripts/localnet.sh clean
localnet-reset:  ; scripts/localnet.sh reset
localnet-status: ; scripts/localnet.sh status
localnet-ps:     ; scripts/localnet.sh ps

# --- Daml (Task 1/2) ---
build:
	cd daml && dpm build --all

# --all is needed for coverage of the main package (a data-dependency); Archive choices are ignored.
test-daml: build
	cd daml/sealed-auction-tests && dpm test --all --show-coverage --coverage-ignore-choice 'Archive$$'

# --- TypeScript ---
typecheck:
	npx tsc --noEmit -p tsconfig.json

test: test-daml typecheck
	npm test

# --- Ops (Task 6) ---
deploy: build
	npm -w packages/ops run deploy -- --dar $(abspath $(DAR)) --topology $(abspath $(TOPOLOGY))

provision:
	npm -w packages/ops run provision -- --topology $(abspath $(TOPOLOGY))

# --- App (Task 7/8) ---
backend:
	npm -w backend start

# --- E2E (Task 10/11) ---
e2e:
	LOCALNET=1 npm -w e2e run e2e

demo:
	LOCALNET=1 npm -w e2e run demo

ui-e2e:
	cd e2e && npx playwright install chromium && LOCALNET=1 npm run ui
