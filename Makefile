.PHONY: setup lint test build up down clean logs migrate seed demo load-smoke

setup:
	npm ci

lint:
	npm run format:check
	npm run lint
	npm run typecheck

test:
	npm run test:coverage

build:
	npm run build

up:
	docker compose up --build --wait

down:
	docker compose down --remove-orphans

clean:
	docker compose down --volumes --remove-orphans
	rm -rf dist coverage artifacts node_modules

logs:
	docker compose logs --follow api worker

migrate:
	docker compose run --rm migrate

seed:
	docker compose exec api node dist/db/seed.js

demo:
	docker compose exec api node --input-type=module -e "console.log('Run npm run demo:scenario from the host')"

load-smoke:
	npm run load:smoke
