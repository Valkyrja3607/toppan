DOCKER_IMAGE = toppan:latest

.PHONY: all
all: help
	# Do nothing

.PHONY: help
help: ## This is help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-$(HELP_WIDTH)s\033[0m %s\n", $$1, $$2}'

.PHONY: clean
clean: ## Clean untracked files.
	git clean -dfx

.PHONY: build
build: ## Docker build
	docker build -t $(DOCKER_IMAGE) -f docker/Dockerfile .

.PHONY: run
run: ## run app
	docker run -it \
		-v $(PWD):/workspace/toppan \
		--name toppan \
		--rm \
		--shm-size=20g \
		-w /workspace/toppan \
		-p 8000:8000 \
		$(DOCKER_IMAGE) uvicorn server:app --host 0.0.0.0 --port 8000 --reload


.PHONY: bash
bash: ## Enter docker image
	docker run -it \
		-v $(PWD):/workspace/toppan \
		--name toppan \
		--rm \
		--shm-size=20g \
		-w /workspace/toppan \
		-p 8000:8000 \
		$(DOCKER_IMAGE) bash
