import {GraphicsBox, GraphicsContainer, ImageTextBox, TextBox, is_image_box} from "core/graphics"
import * as p from "core/properties"
import {Size} from "core/types"
import {color2hexrgb, color2rgba} from "core/util/color"
import {load_image} from "core/util/image"
import {insert_text_on_position} from "core/util/string"
import {FontMetrics, font_metrics, parse_css_length} from "core/util/text"
import {CanvasImage} from "models/glyphs/image_url"
import {BaseText, BaseTextView} from "./base_text"
import {default_provider, MathJaxProvider} from "./providers"

/**
 * Helper class for rendering MathText into Canvas
 */
export abstract class MathTextView extends BaseTextView {
  override model: MathText

  protected graphics_container: GraphicsContainer

  graphics(): GraphicsContainer {
    return this.graphics_container
  }

  protected abstract styled_text(image_box: ImageTextBox): string

  get provider(): MathJaxProvider {
    return default_provider
  }

  override async lazy_initialize() {
    await super.lazy_initialize()

    if (this.provider.status == "not_started")
      await this.provider.fetch()

    this.graphics_container = new GraphicsContainer(this.parse_math_parts())
  }

  override connect_signals(): void {
    super.connect_signals()
    this.on_change(this.model.properties.text, () => {
      this.graphics_container = new GraphicsContainer(this.parse_math_parts())
    })
  }

  private get_image_properties(svg_element: SVGElement, fmetrics: FontMetrics): Size & {v_align: number} {
    const heightEx = parseFloat(
      svg_element
        .getAttribute("height")
        ?.replace(/([A-z])/g, "") ?? "0"
    )

    const widthEx = parseFloat(
      svg_element
        .getAttribute("width")
        ?.replace(/([A-z])/g, "") ?? "0"
    )

    let v_align = fmetrics.descent
    const svg_styles = svg_element?.getAttribute("style")?.split(";")

    if (svg_styles) {
      const rulesMap = new Map()
      svg_styles.forEach(property => {
        const [rule, value] = property.split(":")
        if (rule) rulesMap.set(rule.trim(), value.trim())
      })
      const v_align_length = parse_css_length(rulesMap.get("vertical-align"))
      if (v_align_length?.unit == "ex") {
        v_align += v_align_length.value * fmetrics.x_height
      } else if (v_align_length?.unit == "px") {
        v_align += v_align_length.value
      }
    }

    return {
      width: fmetrics.x_height * widthEx,
      height: fmetrics.x_height * heightEx,
      v_align,
    }
  }

  protected abstract _process_text(image_box: ImageTextBox): HTMLElement | undefined

  private has_images_loaded() {
    return this.graphics().items.filter(is_image_box).every(({image}) => image != null)
  }

  private async load_image(image_box: ImageTextBox): Promise<void> {
    if (!this.has_images_loaded() && (this.provider.status == "not_started" || this.provider.status == "loading")) {
      this.provider.ready.connect(() => this.load_image(image_box))
      this._has_finished = false
      return
    }

    if (!this._has_finished && (this.provider.status == "failed" || this.has_images_loaded())) {
      this._has_finished = true
      return this.parent.notify_finished_after_paint()
    }

    const mathjax_element = this._process_text(image_box)
    if (mathjax_element == null) {
      this._has_finished = true
      return this.parent.notify_finished_after_paint()
    }

    const svg_element = mathjax_element.children[0] as SVGElement
    let svg_image:CanvasImage | null = null

    const outer_HTML = svg_element.outerHTML
    const blob = new Blob([outer_HTML], {type: "image/svg+xml"})
    const url = URL.createObjectURL(blob)

    try {
      svg_image = await load_image(url)
    } finally {
      URL.revokeObjectURL(url)
    }

    image_box.image = svg_image
    image_box.image_properties = this.get_image_properties(svg_element, font_metrics(image_box.font))

    this.parent.request_layout()

    if (this.has_images_loaded()) {
      this._has_finished = true
      this.parent.notify_finished_after_paint()
    }
  }

  private parse_math_parts(): GraphicsBox[] {
    if (!this.provider.MathJax)
      return []

    const {text} = this.model
    // TODO: find mathml
    const tex_parts = this.provider.MathJax.find_tex(text)
    const parts: GraphicsBox[] = []

    let last_index: number | undefined = 0
    for (const part of tex_parts) {
      const _text = text.slice(last_index, part.start.n)
      if (_text)
        parts.push(new TextBox({text: _text}))

      // TODO: implement display mode
      parts.push(new ImageTextBox({ text: part.math, load_image: (image_box: ImageTextBox) => this.load_image(image_box) }))

      last_index = part.end.n
    }

    if (last_index! < text.length) {
      parts.push(new TextBox({text: text.slice(last_index)}))
    }

    return parts
  }
}

export namespace MathText {
  export type Attrs = p.AttrsOf<Props>

  export type Props = BaseText.Props & {
    text: p.Property<string>
  }
}

export interface MathText extends MathText.Attrs {}

export class MathText extends BaseText {
  override properties: MathText.Props
  override __view_type__: MathTextView

  constructor(attrs?: Partial<MathText.Attrs>) {
    super(attrs)
  }
}

export class AsciiView extends MathTextView {
  override model: Ascii

  // TODO: Color ascii
  protected styled_text(): string {
    return this.model.text
  }

  protected _process_text(): HTMLElement | undefined {
    return undefined // TODO: this.provider.MathJax?.ascii2svg(text)
  }
}

export namespace Ascii {
  export type Attrs = p.AttrsOf<Props>
  export type Props = MathText.Props
}

export interface Ascii extends Ascii.Attrs {}

export class Ascii extends MathText {
  override properties: Ascii.Props
  override __view_type__: AsciiView

  constructor(attrs?: Partial<Ascii.Attrs>) {
    super(attrs)
  }

  static {
    this.prototype.default_view = AsciiView
  }
}

export class MathMLView extends MathTextView {
  override model: MathML

  protected styled_text(image_box: ImageTextBox): string {
    let styled = image_box.text.trim()
    let matchs = styled.match(/<math(.*?[^?])?>/s)
    if (!matchs)
      return image_box.text.trim()

    styled = insert_text_on_position(
      styled,
      styled.indexOf(matchs[0]) +  matchs[0].length,
      `<mstyle displaystyle="true" mathcolor="${color2hexrgb(image_box.color)}">`
    )

    matchs = styled.match(/<\/[^>]*?math.*?>/s)
    if (!matchs)
      return image_box.text.trim()

    return insert_text_on_position(styled, styled.indexOf(matchs[0]), "</mstyle>")
  }

  protected _process_text(image_box: ImageTextBox): HTMLElement | undefined {
    const fmetrics = font_metrics(image_box.font)

    return this.provider.MathJax?.mathml2svg(this.styled_text(image_box), {
      em: this.graphics().base_font_size,
      ex: fmetrics.x_height,
    })
  }
}

export namespace MathML {
  export type Attrs = p.AttrsOf<Props>
  export type Props = MathText.Props
}

export interface MathML extends MathML.Attrs {}

export class MathML extends MathText {
  override properties: MathML.Props
  override __view_type__: MathMLView

  constructor(attrs?: Partial<MathML.Attrs>) {
    super(attrs)
  }

  static {
    this.prototype.default_view = MathMLView
  }
}

export class TeXView extends MathTextView {
  override model: TeX

  protected styled_text(image_box: ImageTextBox): string {
    const [r, g, b] = color2rgba(image_box.color)
    return `\\color[RGB]{${r}, ${g}, ${b}} ${image_box.text}`
  }

  protected _process_text(image_box: ImageTextBox): HTMLElement | undefined {
    // TODO: allow plot/document level configuration of macros
    const fmetrics = font_metrics(image_box.font)

    return this.provider.MathJax?.tex2svg(this.styled_text(image_box), {
      display: !this.model.inline,
      em: image_box.base_font_size,
      ex: fmetrics.x_height,
    }, this.model.macros)
  }
}

export namespace TeX {
  export type Attrs = p.AttrsOf<Props>

  export type Props = MathText.Props & {
    macros: p.Property<{[key: string]: string | [string, number]}>
    inline: p.Property<boolean>
  }
}

export interface TeX extends TeX.Attrs {}

export class TeX extends MathText {
  override properties: TeX.Props
  override __view_type__: TeXView

  constructor(attrs?: Partial<TeX.Attrs>) {
    super(attrs)
  }

  static {
    this.prototype.default_view = TeXView

    this.define<TeX.Props>(({Boolean, Number, String, Dict, Tuple, Or}) => ({
      macros: [ Dict(Or(String, Tuple(String, Number))), {} ],
      inline: [ Boolean, false ],
    }))
  }
}
