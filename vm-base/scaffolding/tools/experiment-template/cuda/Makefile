# Build the CUDA search binary. Requires the CUDA toolkit (nvcc).
# Falls back gracefully at runtime if no GPU is present (see src/search.cu).

NVCC ?= nvcc
NVCCFLAGS ?= -O3 -std=c++17
TARGET := search
SRC := src/search.cu

$(TARGET): $(SRC)
	$(NVCC) $(NVCCFLAGS) -o $(TARGET) $(SRC)

.PHONY: clean
clean:
	rm -f $(TARGET)
