; A deliberately wrong InstCombine-style rewrite:
;
;   (x + 1) >s x   ==>   true
;
; It looks obvious, and it is wrong: without the nsw flag the add wraps, so for
; x = INT_MAX the source is false and the target is true.

define i1 @src(i32 %x) {
  %a = add i32 %x, 1
  %c = icmp sgt i32 %a, %x
  ret i1 %c
}

define i1 @tgt(i32 %x) {
  ret i1 true
}
