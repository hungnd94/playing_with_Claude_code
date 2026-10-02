# All the Way Down

A computer built from nothing but NAND gates — and everything above it.

> Work in progress. Layers done so far are checked below.

- [x] **Gates** — `src/hdl.js`, `src/gates.js`: NOT, AND, OR, XOR, MUX, adders, decoders… all wired from 2-input NANDs.
- [x] **CPU** — `src/cpu.js`: *N16*, a 16-bit single-cycle RISC with an 8-register file, barrel shifter
      and a signed array multiplier. ~6,000 NAND gates + 128 flip-flops.
- [x] **Simulator** — `src/netlist.js` optimises the netlist (still pure NAND), `src/wasm.js` compiles it
      to WebAssembly: one wasm instruction sequence per gate, ~1.7 million clock cycles per second.
- [x] **Verification** — the gate-level CPU is differentially tested against the ISA spec (`src/isa.js`)
      on random programs; a flip-flop built from 11 NANDs is shown to match the flip-flop primitive.
- [ ] Assembler
- [ ] Compiler
- [ ] Programs
- [ ] Browser front-end

```
npm test
```
