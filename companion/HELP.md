# Kuinta tools Event Master

This module is a **programming aid**. It is **essential to test it thoroughly before using it in a show.** Check every button and workflow on your own unit and firmware first.

Controls an Event Master (E2, S3-4K, EX, Encore 3) through its JSON-RPC API (HTTP, port 9999).
If you run a host/client setup, point the module at the **host** unit.

## Workflow

1. **Arm / Unarm destination** – arms one Screen Destination or Aux (only one can be armed at a time).
2. **Select layer** – picks one layer of the armed Screen Destination (one layer at a time). Aux destinations have no layers.
3. **Assign input to layer** – routes the chosen source to the selected layer (or directly to the armed Aux).

## Variables

`armed_destination`, `armed_type`, `selected_layer`, `selected_layer_source`, `layer_list`

## Feedbacks

* **Destination is armed**
* **Layer is selected**

## Position, size and guides (programming workflow)

Arm a Screen Destination, select a **real layer**, then use:

* **Align selected layer** – Left / Right / Top / Bottom / H Center / V Center / Center.
  *Reference = Destination* aligns to the destination edges. *Reference = Guides* aligns inside the area between your guides that the layer currently sits in.
* **Fill selected layer** – Full screen Horizontal, Full screen Vertical, Fill H/V.
* **Set guides** – type the pixel positions of your Snapping Guides by hand (**H guides** are used for horizontal alignment - H Center / Left / Right between two of them; **V guides** are used for vertical alignment - V Center / Top / Bottom). They are saved per destination.

Example: destination height 2160, V guides `300, 1500`, layer height 500 -> V Center between guides puts VPos at 650.

The Event Master JSON API documentation I could find does not expose Snapping Guides, so they must be entered manually.

## Background

The layer list also contains **Background – Preview** and **Background – Program**. Select one and use *Assign input*.

## Experimental

* **Recall user key**, **Save preset (Save from PVW / PGM)**: parameters are not confirmed in the public documentation.
* **Send raw JSON-RPC**: sends any method and prints the reply to the Companion log (useful to explore what your unit supports).

## ShuttlePRO v2 (jog + shuttle ring)

1. Arm a Screen Destination and select a real layer.
2. Press one of the **Shuttle** buttons to choose what the dials change: **Size**, **V Position**, **H Position**, or a mask edge (**Mask Left / Right / Top / Bottom**). The active one lights up.
3. Turn the dials. Drag the three presets of the **Shuttle rotary** category onto the surface:
   * **Jog wheel** (inner ring): one step per click.
   * **Shuttle ring, one step per stop**: Companion sends one rotate action per ring stop (+/-7).
   * **Shuttle ring, frequency proportional**: Companion repeats the rotate action faster the further the ring is turned.
   See the Companion page "Contour Shuttle" for which surface location is which.
4. The step size is the **Step per click** option of the rotate actions (pixels; mask units for mask edges). It accepts variables, for example `$(custom:contourShuttleRing)` makes the step grow with the ring position.
5. **Mask Disable** remembers the current mask of the layer and sets it to 0; **Mask Enable** restores it (the documented layer data has no mask on/off flag).

Repeated rotate events are batched: at most one write every 60 ms, so a fast shuttle ring does not flood the processor.

## Multi-select (v0.3.0)

Press **Multi-select** (Arm destination tab) to turn it on. While it is on, pressing a destination adds it to the selection (press again to remove it).
The layer you select is then used on **all** armed screens: assign input, Align/Fill, rotary editing, mask and recall user key apply to each of them (each screen uses its own size and guides).
Save User Key / Save Preset need exactly one armed screen. Turning multi-select off keeps only the first armed destination.

## Layer buttons A / B (v0.4.0)

Layers come in A/B pairs: Layer 1 = 1A + 1B (ids 0 and 1), Layer 2 = 2A + 2B (ids 2 and 3) ...
The **Layer N** buttons (Select layer tab) pick, on EVERY armed destination, the layer of the pair that is not on program, so what you set up appears in preview. Press the button again after a transition to move to the other one. The buttons under "Select layer (A/B direct)" select a specific physical layer.
User keys were removed (the Event Master API cannot save them).

## Clear layer
**Clear layer** removes the selected layer (the A or B that is selected on each armed screen) from the preview, like the Clear button in Toolset.
