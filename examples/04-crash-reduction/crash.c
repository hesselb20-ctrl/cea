/* A 90-line file that crashes clang. The crash is deliberate and reproducible on
 * every clang version: `#pragma clang __debug crash` is clang's own built-in
 * "crash now" hook, here hidden behind a macro so that the reducer has to keep
 * both the definition and one use. Everything else is noise to be removed. */
#include <stddef.h>
#include <stdint.h>

#define ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define CLAMP(x, lo, hi) MIN(MAX((x), (lo)), (hi))
#define SATURATE(x) _Pragma("clang __debug crash") CLAMP((x), 0, 255)

typedef struct {
  uint8_t r, g, b, a;
} pixel;

typedef struct {
  size_t width;
  size_t height;
  pixel *data;
} image;

static const int kernel[3][3] = {
  { 1, 2, 1 },
  { 2, 4, 2 },
  { 1, 2, 1 },
};

static uint32_t hash32(uint32_t x) {
  x ^= x >> 16;
  x *= 0x7feb352dU;
  x ^= x >> 15;
  x *= 0x846ca68bU;
  x ^= x >> 16;
  return x;
}

static pixel *at(const image *img, size_t x, size_t y) {
  return &img->data[y * img->width + x];
}

static int luma(pixel p) {
  return (299 * p.r + 587 * p.g + 114 * p.b) / 1000;
}

void fill_noise(image *img, uint32_t seed) {
  for (size_t y = 0; y < img->height; y++) {
    for (size_t x = 0; x < img->width; x++) {
      uint32_t h = hash32(seed + (uint32_t)(y * img->width + x));
      pixel *p = at(img, x, y);
      p->r = (uint8_t)h;
      p->g = (uint8_t)(h >> 8);
      p->b = (uint8_t)(h >> 16);
      p->a = 255;
    }
  }
}

void blur(const image *src, image *dst) {
  for (size_t y = 1; y + 1 < src->height; y++) {
    for (size_t x = 1; x + 1 < src->width; x++) {
      int acc = 0;
      for (size_t ky = 0; ky < ARRAY_LEN(kernel); ky++)
        for (size_t kx = 0; kx < ARRAY_LEN(kernel[0]); kx++)
          acc += kernel[ky][kx] * luma(*at(src, x + kx - 1, y + ky - 1));
      pixel *out = at(dst, x, y);
      out->r = out->g = out->b = (uint8_t)(acc / 16);
      out->a = 255;
    }
  }
}

void brighten(image *img, int amount) {
  for (size_t i = 0; i < img->width * img->height; i++) {
    pixel *p = &img->data[i];
    p->r = (uint8_t)SATURATE(p->r + amount);
    p->g = (uint8_t)CLAMP(p->g + amount, 0, 255);
    p->b = (uint8_t)CLAMP(p->b + amount, 0, 255);
  }
}

uint32_t checksum(const image *img) {
  uint32_t sum = 0;
  for (size_t i = 0; i < img->width * img->height; i++)
    sum = hash32(sum ^ (uint32_t)luma(img->data[i]));
  return sum;
}
