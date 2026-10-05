; printsim fixture: real MINI+ start G-code from a lab print
; (2 Oct 2026, Brandeis, Ghosts_0.4n_0.2mm_PLA_MINIIS_1h27m) plus a short body.
; Not a sliced part. Do not replace this with a real .bgcode.

; printer_model = MINI
; filament_type = PLA
; layer_height = 0.2
; max_layer_z = 0.4
; nozzle_diameter = 0.4
; filament_colour = #F2F2EE
; bed_temperature = 60
; temperature = 230
; The real file's M73 R starts at 87 (an 87 min print). This fixture's body is
; only a few moves, so the slicer estimate stays short: stretching those moves
; out to 87 min would also stretch the travel before the second M109 and the
; nozzle would already be at 230 when the wait begins.
; estimated printing time (normal mode) = 1m 0s

M73 P0 R87
M73 Q0 S90
M201 X4000 Y4000 Z400 E5000
M203 X400 Y400 Z12 E80
M204 P4000 R1250 T4000
M205 X8.00 Y8.00 Z2.00 E10.00
M205 S0 T0
;TYPE:Custom
M862.3 P "MINI"
M862.1 P0.4 A0 F0
M862.5 P2
M862.6 P"Input shaper"
M115 U6.4.0+11974
G90
M83
M104 S170
M140 S60
M109 R170
M190 S60
M569 S1 X Y
M204 T1250
G28
G29
M104 S230
G92 E0
G1 X0 Y-2 Z3 F2400
M109 S230
; intro line
G1 X10 Z0.2 F1000
G1 X70 E8 F900
G1 X140 E10 F700
M73 P0 R86
G92 E0
M569 S0 X Y
M204 T4000
M572 W0.06
M221 S95
G21
G90
M83
M572 S0.27
M107
;LAYER_CHANGE
;Z:0.2
;HEIGHT:0.2
;TYPE:External perimeter
;WIDTH:0.45
G1 X100 Y100 F9000
G1 E0.7 F1500
G1 X120 Y100 E0.8 F1800
G1 X120 Y120 E0.8
G1 X100 Y120 E0.8
G1 X100 Y100 E0.8
M73 P25 R65
;LAYER_CHANGE
;Z:0.4
;HEIGHT:0.2
G1 Z0.4 F720
M104 S220
G1 X100 Y100 F9000
G1 X120 Y100 E0.8 F1800
G1 X120 Y120 E0.8
G1 X100 Y120 E0.8
G1 X100 Y100 E0.8
M73 P50 R43
G4 S30
M73 P100 R0
