// GPU-parallel search kernels for the problem in problem.md (snapshot root).
//
// Use CUDA when the candidate space is massively parallel - e.g. scoring huge
// batches of candidates in parallel. If no GPU is present, fall back to the
// Rust path in ../rust (see AGENTS.md §2 at the snapshot root).
//
// Build:  make        (see ./Makefile)
// This is a scaffold: the kernel below is a placeholder to confirm the toolchain.

#include <cstdio>

__global__ void hello_kernel() {
    if (threadIdx.x == 0 && blockIdx.x == 0) {
        printf("cuda experiment: kernel online\n");
    }
}

int main() {
    int devices = 0;
    cudaError_t err = cudaGetDeviceCount(&devices);
    if (err != cudaSuccess || devices == 0) {
        printf("No CUDA device available; use the Rust path in ../rust instead.\n");
        return 0;
    }
    hello_kernel<<<1, 32>>>();
    cudaDeviceSynchronize();
    printf("TODO: implement GPU search. Verify every candidate with check_answer/.\n");
    return 0;
}
