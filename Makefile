.PHONY: install dev build check test ci macos package-macos clean

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

check:
	npm run format:check
	npm run lint
	npm run check

test:
	npm test -- --run

ci:
	npm run ci

macos:
	swift build --package-path apps/macos -c release --arch arm64

package-macos:
	./deploy/macos/package.sh release pkg

clean:
	npm run clean
