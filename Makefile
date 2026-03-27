prepare-gh: ## Create GitHub repo and enable Pages deployment via Actions
	@gh repo create $(shell basename $(CURDIR)) --public 2>/dev/null || true
	@git remote get-url origin > /dev/null 2>&1 \
		&& git remote set-url origin git@github.com:$(shell gh api user --jq .login)/$(shell basename $(CURDIR)).git \
		|| git remote add origin git@github.com:$(shell gh api user --jq .login)/$(shell basename $(CURDIR)).git
	@git push -u origin main 2>/dev/null || true
	@gh api --method POST /repos/{owner}/{repo}/pages \
		-f build_type=workflow > /dev/null 2>&1 \
	|| gh api --method PUT /repos/{owner}/{repo}/pages \
		-f build_type=workflow > /dev/null
	@gh repo edit --homepage "https://$(shell gh api user --jq .login).github.io/$(shell basename $(CURDIR))/"
	@echo "GitHub repo created and Pages enabled via Actions."

# These make tasks allow the default help text to work properly.
%:
	@true

.PHONY: help prepare-gh

help:
	@echo 'Usage: make <command>'
	@echo
	@echo 'where <command> is one of the following:'
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
