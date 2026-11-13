#include <stdio.h>
#include <limits.h>
static int check(int x) { return x + 1 > x; }
int main(void) { int v = INT_MAX; printf("%d\n", check(v)); return 0; }
