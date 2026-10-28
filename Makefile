# 只做几条薄封装，逻辑都在 tools/ 和 test/ 里
PYTHON ?= python3
NODE   ?= node

.DEFAULT_GOAL := help

help:
	@echo "make build    生成 dist/<name>-<version>.{zip,xpi}（两个内容相同）"
	@echo "make xpi      同 make build（Firefox 用 .xpi 后缀）"
	@echo "make zip      只生成 .zip（Chrome / Edge）"
	@echo "make test     冒烟测试（无浏览器，91 项）"
	@echo "make e2e      真机 Chromium 端到端测试"
	@echo "make check    语法检查 + manifest 校验 + 冒烟测试"
	@echo "make icons    重新生成图标"
	@echo "make clean    删除 dist/"

build:
	$(PYTHON) tools/pack.py

xpi:
	$(PYTHON) tools/pack.py --only xpi

zip:
	$(PYTHON) tools/pack.py --only zip

test:
	TZ=Asia/Shanghai $(NODE) test/smoke.test.mjs

e2e:
	$(NODE) test/e2e.mjs

check: test
	@for f in common.js worker.js inject/main.js inject/isolated.js options/options.js popup/popup.js; do \
		$(NODE) --check $$f || exit 1; \
	done
	@$(PYTHON) tools/pack.py --only zip >/dev/null && echo "打包自检通过"

icons:
	$(PYTHON) tools/make-icons.py

clean:
	rm -rf dist

.PHONY: help build xpi zip test e2e check icons clean
