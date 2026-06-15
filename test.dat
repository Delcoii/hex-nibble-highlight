#include <stdio.h>
#include <stdint.h>

// Active code: should be nibble-highlighted normally.
static const uint64_t kActiveA = 0x1122334455667788ULL;
static const uint64_t kActiveB = 0xDEADBEEF00ABCDEFULL;

#if 0
// Inactive code: should be gray and NOT nibble-highlighted by this extension.
static const uint64_t kInactiveTop = 0xAAAABBBBCCCCDDDDULL;
static const uint32_t kInactiveTop2 = 0x89ABCDEFU;

#if 1
// Nested inside inactive parent: still inactive (gray).
static const uint32_t kNestedInInactive = 0x12345678U;
#endif

#else
// Active alternative branch: should be nibble-highlighted.
static const uint32_t kElseActive = 0x01020304U;
#endif

#if (1 && (3 > 2))
// Active branch from evaluatable expression.
static const uint32_t kExprActive = 0xCAFEBABEU;
#elif 1
// Not taken because previous branch is true.
static const uint32_t kExprElifInactive = 0x0BADF00DU;
#else
// Not taken.
static const uint32_t kExprElseInactive = 0xFEEDFACEU;
#endif

#if 1
static const uint32_t kNestedParentActive = 0x77778888U;

#if 0
// Inactive nested child.
static const uint32_t kNestedChildInactive = 0x11112222U;
#else
// Active nested child.
static const uint32_t kNestedChildActive = 0x33334444U;
#endif

#endif

int main(void) {
    uint32_t value = 0xA5A55A5AU;

    // These in comments should remain uncolored by nibble decoration.
    // 0xAAAAAAAA
    /* 0xBBBBBBBB */

    // These in strings should still be matched by current extension behavior.
    const char *s1 = "0xCCCCCCCC in string";
    const char *s2 = "0xDDDDDDDD in string";

    printf("value = 0x%08X, %s, %s\n", value, s1, s2);
    return 0;
}
