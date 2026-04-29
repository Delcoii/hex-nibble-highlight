#include <stdint.h>

#define REG_BASE       0x40000000
#define MASK_VALUE     0xFFFF0000
#define MAGIC_VALUE    0xDEADBEEF
#define LONG_VALUE     0x12345678ABCDEF00ULL
#define LOWER_VALUE    0xffffabcd12345678u

uint32_t value = 0xA5A55A5A;