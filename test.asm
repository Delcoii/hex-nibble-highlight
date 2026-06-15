; x86-style: active hex literals (nibble colors)
    mov eax, 0xDEADBEEF
    mov ebx, 0x1234

; comment hex — should NOT be highlighted
; mask = 0xFFFFFFFF

# GNU line comment at start — should NOT highlight
# dead = 0xAAAAAAAA

    mov ecx, 0xCAFEBABE    ; trailing comment 0xBAD

/* block comment 0xBBBBBBBB */

.data
hex64   dq 0x1122334455667788
msg     db "literal 0xCCCCCCCC in string", 0

; ARM-style immediate — #0x must stay highlighted (not a comment)
    mov r0, #0xA5A55A5A
