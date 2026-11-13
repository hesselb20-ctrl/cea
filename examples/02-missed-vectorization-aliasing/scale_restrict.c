/* Same program; `restrict` on out promises that out[i] does not alias *v or
 * v->data, so v->n and v->data are loop-invariant and the loop vectorises. */
#include <stdio.h>
#include <stdlib.h>

struct vec {
  int *data;
  int n;
};

__attribute__((noinline))
void scale(struct vec *v, int *restrict out, int k) {
  for (int i = 0; i < v->n; i++)
    out[i] = v->data[i] * k;
}

int main(void) {
  enum { N = 4096, REPS = 200000 };
  struct vec v = { malloc(N * sizeof(int)), N };
  int *out = malloc(N * sizeof(int));
  for (int i = 0; i < N; i++) v.data[i] = i;
  unsigned sum = 0;
  for (int r = 0; r < REPS; r++) {
    scale(&v, out, r & 7);
    sum += (unsigned)out[r % N];
  }
  printf("%u\n", sum);
  free(v.data);
  free(out);
  return 0;
}
