; The same rewrite with the precondition that makes it valid: `add nsw`.
; nsw is a promise that the add does not overflow; if it does, the result is
; poison, and a poison source may be refined to anything, including true.

define i1 @src(i32 %x) {
  %a = add nsw i32 %x, 1
  %c = icmp sgt i32 %a, %x
  ret i1 %c
}

define i1 @tgt(i32 %x) {
  ret i1 true
}
