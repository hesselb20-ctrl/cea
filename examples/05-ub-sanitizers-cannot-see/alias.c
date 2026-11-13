/* Prints 1073741824 at -O0 and 1 at -O2, and UBSan and ASan are both silent.
 * It is still not a compiler bug: writing a float through a pointer to an int
 * object violates the strict aliasing rule (C11 6.5p7), which no sanitizer in
 * this toolchain checks. */
#include <stdio.h>

__attribute__((noinline))
int store_both(int *i, float *f) {
  *i = 1;
  *f = 2.0f;
  return *i;
}

int main(void) {
  int x = 0;
  printf("%d\n", store_both(&x, (float *)&x));
  return 0;
}
