/**
 * レシートのブロックエディタ＋コード編集＋印字と同じプレビュー
 * （Shopify の POS レシートのブロックエディタを手本にした形）
 *
 * 左: ブロックの一覧（並べ替え・表示切替・削除・設定）／見た目／コード
 * 右: プレビュー（receiptLayoutRender.ts の印字と同じ関数で描く。見本のデータ）
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIconButton, MoveIconButton, SectionTabs, markFormDirty } from "./admin-ui";
import {
  blockDefsForKind,
  defaultSettings,
  getBlockDef,
  type SettingDef,
} from "../services/receiptLayoutBlocks";
import { sampleTemplateData } from "../services/receiptLayoutData";
import { presetsForKind } from "../services/receiptLayoutPresets";
import {
  blocksToCode,
  isSafeImageUrl,
  paperWidthPx,
  renderReceiptLayout,
  textSettingProblem,
} from "../services/receiptLayoutRender";
import {
  LAYOUT_LIMITS,
  type BlockSettingValue,
  type LayoutBlock,
  type ReceiptKind,
  type ReceiptLayout,
} from "../services/receiptLayoutSchema";
import { TEMPLATE_VARIABLES } from "../services/receiptLayoutVariables";

type Tab = "blocks" | "style" | "code";

function newBlockId(type: string, blocks: LayoutBlock[]): string {
  let n = blocks.length + 1;
  let id = `${type}-${n}`.replace(/[^A-Za-z0-9_-]/g, "");
  while (blocks.some((b) => b.id === id)) id = `${type}-${++n}`;
  return id;
}

function blockSummary(block: LayoutBlock): string {
  const def = getBlockDef(block.type);
  if (!def?.summaryKey) return "";
  const v = String(block.settings[def.summaryKey] ?? "").replace(/\s+/g, " ").trim();
  return v.length > 24 ? `${v.slice(0, 24)}…` : v;
}

/**
 * 数の欄。打っている途中（空・「1.」など）は文字のまま持ち、数として読めたときだけ親へ渡す。
 * 範囲の外・空は欄の下に赤い文字で出す（保存の前の確認でも止まる）。
 */
function NumField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  helpText,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  helpText?: string;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // 外から値が変わったとき（ひな形・破棄）は欄も合わせる
  useEffect(() => {
    if (Number(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const n = draft.trim() === "" ? NaN : Number(draft);
  const error = !Number.isFinite(n) ? "数を入れてください" : n < min || n > max ? `${min}〜${max} にしてください` : undefined;
  return (
    <TextField
      label={label}
      type="number"
      autoComplete="off"
      value={draft}
      min={min}
      max={max}
      step={step}
      suffix={suffix}
      helpText={helpText}
      error={error}
      onChange={(v) => {
        setDraft(v);
        const parsed = v.trim() === "" ? NaN : Number(v);
        if (Number.isFinite(parsed) && !v.endsWith(".")) onChange(parsed);
      }}
    />
  );
}

function SettingField({ def, value, onChange }: { def: SettingDef; value: BlockSettingValue; onChange: (v: BlockSettingValue) => void }) {
  switch (def.type) {
    case "checkbox":
      return <Checkbox label={def.label} checked={value === true} onChange={(v) => onChange(v)} helpText={def.help} />;
    case "select":
      if (def.options.length <= 5) {
        return (
          <ChoiceList
            title={def.label}
            choices={def.options.map((o) => ({ label: o.label, value: o.value }))}
            selected={[String(value)]}
            onChange={(v) => onChange(v[0] ?? def.default)}
          />
        );
      }
      return <Select label={def.label} options={def.options} value={String(value)} onChange={(v) => onChange(v)} helpText={def.help} />;
    case "number":
      return (
        <NumField
          label={def.label}
          value={Number(value)}
          min={def.min}
          max={def.max}
          suffix={def.unit}
          helpText={def.help}
          onChange={(v) => onChange(v)}
        />
      );
    case "url":
      return (
        <TextField
          label={def.label}
          type="url"
          autoComplete="off"
          value={String(value)}
          helpText={def.help}
          onChange={(v) => onChange(v.trim())}
          error={isSafeImageUrl(String(value)) ? undefined : "https:// で始まる画像の URL にしてください"}
        />
      );
    case "textarea":
    case "text": {
      const v = String(value);
      const error = textSettingProblem(v)
        ? textSettingProblem(v)!
        : v.length > LAYOUT_LIMITS.maxTextLength
          ? `${LAYOUT_LIMITS.maxTextLength} 文字までです`
          : undefined;
      return (
        <TextField
          label={def.label}
          autoComplete="off"
          value={v}
          multiline={def.type === "textarea" ? 3 : undefined}
          placeholder={"placeholder" in def ? def.placeholder : undefined}
          helpText={def.help}
          onChange={(nv) => onChange(nv)}
          error={error}
        />
      );
    }
  }
}

function Preview({ html, widthPx }: { html: string; widthPx: number }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(600);
  // 幅の狭い画面（iPhone など）では、用紙の幅のまま縮めて全体を見せる（右が切れないように）
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientWidth;
      setScale(avail > 0 && avail < widthPx + 2 ? avail / (widthPx + 2) : 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [widthPx]);
  const fit = () => {
    // スクリプトは動かさない（sandbox に allow-scripts を付けない）。高さを読むため同じ origin だけ許す
    const doc = frame.current?.contentDocument;
    if (doc?.body) setHeight(Math.max(200, doc.documentElement.scrollHeight + 4));
  };
  return (
    <div ref={box} className="RL-preview-box">
      <div style={{ width: (widthPx + 2) * scale, height: height * scale, margin: "0 auto", overflow: "hidden" }}>
        <div
          className="RL-preview-paper"
          style={{ width: widthPx + 2, transform: scale < 1 ? `scale(${scale})` : undefined, transformOrigin: "top left" }}
        >
          <iframe
            ref={frame}
            title="レシートのプレビュー"
            sandbox="allow-same-origin"
            srcDoc={html}
            onLoad={fit}
            style={{ width: widthPx, height, border: 0, display: "block", background: "#fff" }}
          />
        </div>
      </div>
    </div>
  );
}

const EDITOR_CSS = `
.RL-grid{display:grid;grid-template-columns:minmax(320px,420px) minmax(0,1fr);gap:16px;align-items:start}
.RL-preview{position:sticky;top:16px;display:flex;flex-direction:column;align-items:center;gap:8px;background:#f1f1f1;border-radius:12px;padding:16px;overflow:auto;max-height:calc(100vh - 32px)}
.RL-preview-box{width:100%;min-width:0}
.RL-preview-paper{box-shadow:0 1px 4px rgba(0,0,0,.18);background:#fff}
.RL-jump{display:none}
.RL-row{display:flex;align-items:center;gap:4px;padding:6px 8px;border-radius:8px;cursor:pointer}
.RL-row:hover{background:#f6f6f6}
.RL-row[aria-current=true]{background:#ebebeb}
.RL-row-title{flex:1;min-width:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.RL-row[data-hidden=true] .RL-row-title{color:#8a8a8a;text-decoration:line-through}
.RL-settings{padding:8px 8px 16px 16px;border-left:2px solid #e3e3e3;margin:0 0 8px 12px}
.RL-code{width:100%;min-height:480px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;border:1px solid #8a8a8a;border-radius:8px;padding:8px;resize:vertical;tab-size:2;white-space:pre;overflow:auto}
.RL-vars{font-size:12px}
.RL-vars code{font-size:12px}
@media (max-width: 900px){.RL-grid{grid-template-columns:minmax(0,1fr)}.RL-preview{position:static;max-height:none;padding:8px}.RL-jump{display:block}.RL-code{font-size:16px}}
`;

export function ReceiptLayoutEditor({
  kind,
  initial,
  onLayoutChange,
}: {
  kind: ReceiptKind;
  /** 開いた時点（保存した時点）のレイアウト。「破棄」でここに戻す */
  initial: ReceiptLayout;
  /** 今の値を親のフォームへ（保存の帯の判定と送信用） */
  onLayoutChange: (layout: ReceiptLayout) => void;
}) {
  const [layout, setLayout] = useState<ReceiptLayout>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initial.mode === "code" ? "code" : "blocks");
  const [addType, setAddType] = useState<string>(blockDefsForKind(kind)[0]?.type ?? "");
  const [presetId, setPresetId] = useState<string>(presetsForKind(kind)[0]?.id ?? "standard");
  const root = useRef<HTMLDivElement | null>(null);

  // 「破棄」などで親が initial を差し替えたら、編集中の値も戻す
  useEffect(() => {
    setLayout(initial);
    setTab(initial.mode === "code" ? "code" : "blocks");
  }, [initial]);

  const update = (next: ReceiptLayout) => {
    setLayout(next);
    onLayoutChange(next);
  };
  // 親の hidden の値が変わったあとで、保存の帯に知らせる
  useEffect(() => {
    markFormDirty(root.current);
  }, [layout]);

  // コードは打つたびに描かず、少し待ってから描く
  const [renderTarget, setRenderTarget] = useState(layout);
  useEffect(() => {
    const t = window.setTimeout(() => setRenderTarget(layout), layout.mode === "code" ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [layout]);
  const rendered = useMemo(() => renderReceiptLayout(renderTarget, sampleTemplateData(kind)), [renderTarget, kind]);

  const defs = blockDefsForKind(kind);
  const setBlocks = (blocks: LayoutBlock[]) => update({ ...layout, blocks });
  const move = (i: number, d: -1 | 1) => {
    const blocks = [...layout.blocks];
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    setBlocks(blocks);
  };
  const addBlock = () => {
    const def = getBlockDef(addType);
    if (!def || layout.blocks.length >= LAYOUT_LIMITS.maxBlocks) return;
    const block: LayoutBlock = { id: newBlockId(def.type, layout.blocks), type: def.type, hidden: false, settings: defaultSettings(def) };
    const at = selected ? layout.blocks.findIndex((b) => b.id === selected) + 1 : layout.blocks.length;
    const blocks = [...layout.blocks];
    blocks.splice(at, 0, block);
    setBlocks(blocks);
    setSelected(block.id);
  };
  const applyPreset = () => {
    const preset = presetsForKind(kind).find((p) => p.id === presetId);
    if (!preset) return;
    // 用紙の幅は今の値を残す（ひな形は見た目だけ）
    update({ ...preset.build(kind), paperWidthMm: layout.paperWidthMm });
    setSelected(null);
    setTab("blocks");
  };

  const onCodeKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value } = el;
    const next = `${value.slice(0, s)}  ${value.slice(en)}`;
    update({ ...layout, code: next });
    window.requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  };

  return (
    <div ref={root}>
      <style>{EDITOR_CSS}</style>
      <div className="RL-grid">
        <BlockStack gap="400">
          <div className="RL-jump">
            <Button
              variant="tertiary"
              onClick={() => document.getElementById("rl-preview")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              プレビューを見る
            </Button>
          </div>
          <SectionTabs
            label="編集すること"
            items={[
              { key: "blocks", label: "ブロック" },
              { key: "style", label: "見た目" },
              { key: "code", label: "コード" },
            ]}
            selected={tab}
            onSelect={(v: string) => setTab(v as Tab)}
          />

          {tab === "blocks" ? (
            <Card>
              <BlockStack gap="300">
                {layout.mode === "code" ? (
                  <Text as="p" tone="caution">
                    今はコードで印字しています。ブロックの変更は「コード」の「ブロックに戻す」を押すまで印字に出ません。
                  </Text>
                ) : null}
                <div role="list" aria-label="ブロックの一覧">
                  {layout.blocks.map((block, i) => {
                    const def = getBlockDef(block.type);
                    if (!def) return null;
                    const open = selected === block.id;
                    const summary = blockSummary(block);
                    return (
                      <div role="listitem" key={block.id}>
                        <div
                          className="RL-row"
                          aria-current={open}
                          data-hidden={block.hidden === true}
                          onClick={() => setSelected(open ? null : block.id)}
                        >
                          <button
                            type="button"
                            className="RL-row-title"
                            aria-expanded={open}
                            style={{ textAlign: "left", background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer" }}
                          >
                            {def.label}
                            {summary ? <Text as="span" tone="subdued">{`　${summary}`}</Text> : null}
                          </button>
                          <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", gap: 2 }}>
                            <MoveIconButton label="上へ" direction="up" onClick={() => move(i, -1)} disabled={i === 0} />
                            <MoveIconButton label="下へ" direction="down" onClick={() => move(i, 1)} disabled={i === layout.blocks.length - 1} />
                            <Button
                              variant="tertiary"
                              accessibilityLabel={block.hidden ? "表示する" : "隠す"}
                              onClick={() => setBlocks(layout.blocks.map((b) => (b.id === block.id ? { ...b, hidden: !b.hidden } : b)))}
                            >
                              {block.hidden ? "表示" : "隠す"}
                            </Button>
                            <DeleteIconButton
                              label="削除"
                              onClick={() => {
                                setBlocks(layout.blocks.filter((b) => b.id !== block.id));
                                if (open) setSelected(null);
                              }}
                            />
                          </span>
                        </div>
                        {open ? (
                          <div className="RL-settings">
                            <BlockStack gap="300">
                              <Text as="p" tone="subdued">{def.description}</Text>
                              {def.settings.map((s) => (
                                <SettingField
                                  key={s.key}
                                  def={s}
                                  value={block.settings[s.key] ?? s.default}
                                  onChange={(v) =>
                                    setBlocks(layout.blocks.map((b) => (b.id === block.id ? { ...b, settings: { ...b.settings, [s.key]: v } } : b)))
                                  }
                                />
                              ))}
                            </BlockStack>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <InlineStack gap="200" blockAlign="end" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <Select
                      label="ブロックを追加"
                      options={defs.map((d) => ({ label: d.label, value: d.type }))}
                      value={addType}
                      onChange={setAddType}
                      helpText={getBlockDef(addType)?.description}
                    />
                  </div>
                  <Button onClick={addBlock} disabled={layout.blocks.length >= LAYOUT_LIMITS.maxBlocks}>追加</Button>
                </InlineStack>
                <InlineStack gap="200" blockAlign="end" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <Select
                      label="ひな形から作り直す"
                      options={presetsForKind(kind).map((p) => ({ label: p.label, value: p.id }))}
                      value={presetId}
                      onChange={setPresetId}
                      helpText="今のブロックを置きかえます。保存するまでは「破棄」で戻せます。"
                    />
                  </div>
                  <Button onClick={applyPreset}>置きかえる</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          ) : null}

          {tab === "style" ? (
            <Card>
              <BlockStack gap="300">
                <ChoiceList
                  title="用紙の幅"
                  choices={[
                    { label: "80mm", value: "80" },
                    { label: "58mm", value: "58" },
                  ]}
                  selected={[String(layout.paperWidthMm)]}
                  onChange={(v) => update({ ...layout, paperWidthMm: v[0] === "58" ? 58 : 80 })}
                />
                <NumField
                  label="文字の大きさ"
                  suffix="px"
                  min={LAYOUT_LIMITS.fontSizePx.min}
                  max={LAYOUT_LIMITS.fontSizePx.max}
                  value={layout.style.fontSizePx}
                  onChange={(v) => update({ ...layout, style: { ...layout.style, fontSizePx: v } })}
                />
                <ChoiceList
                  title="文字の太さ"
                  choices={[
                    { label: "標準", value: "400" },
                    { label: "やや太い", value: "600" },
                    { label: "太い", value: "700" },
                  ]}
                  selected={[String(layout.style.fontWeight)]}
                  onChange={(v) => update({ ...layout, style: { ...layout.style, fontWeight: Number(v[0]) as 400 | 600 | 700 } })}
                />
                <ChoiceList
                  title="書体"
                  choices={[
                    { label: "ゴシック", value: "sans" },
                    { label: "明朝", value: "serif" },
                    { label: "等幅", value: "mono" },
                  ]}
                  selected={[layout.style.fontFamily]}
                  onChange={(v) => update({ ...layout, style: { ...layout.style, fontFamily: v[0] as ReceiptLayout["style"]["fontFamily"] } })}
                />
                <NumField
                  label="行の高さ"
                  
                  step={0.05}
                  min={LAYOUT_LIMITS.lineHeight.min}
                  max={LAYOUT_LIMITS.lineHeight.max}
                  value={layout.style.lineHeight}
                  onChange={(v) => update({ ...layout, style: { ...layout.style, lineHeight: v } })}
                />
                <NumField
                  label="余白"
                  suffix="px"
                  min={LAYOUT_LIMITS.paddingPx.min}
                  max={LAYOUT_LIMITS.paddingPx.max}
                  value={layout.style.paddingPx}
                  onChange={(v) => update({ ...layout, style: { ...layout.style, paddingPx: v } })}
                />
                <TextField
                  label="追加の CSS"
                  autoComplete="off"
                  multiline={4}
                  monospaced
                  value={layout.style.customCss}
                  helpText="ブロックの見た目を細かく変えるときに使います（例: .logo-text{font-size:3em}）。"
                  onChange={(v) => update({ ...layout, style: { ...layout.style, customCss: v } })}
                />
              </BlockStack>
            </Card>
          ) : null}

          {tab === "code" ? (
            <Card>
              <BlockStack gap="300">
                {layout.mode === "blocks" ? (
                  <>
                    <Text as="p">
                      今のブロックからテンプレート（Liquid）のコードを作り、コードで細かく作り込めます。コードで保存すると、印字はコードを使います。
                    </Text>
                    <InlineStack>
                      <Button onClick={() => update({ ...layout, mode: "code", code: blocksToCode(layout) })}>コードで編集を始める</Button>
                    </InlineStack>
                  </>
                ) : (
                  <>
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" tone="subdued">{`${layout.code.length.toLocaleString()} / ${LAYOUT_LIMITS.maxCodeLength.toLocaleString()} 文字`}</Text>
                      <InlineStack gap="200">
                        <Button onClick={() => update({ ...layout, code: blocksToCode(layout) })}>ブロックから作り直す</Button>
                        <Button onClick={() => update({ ...layout, mode: "blocks" })}>ブロックに戻す</Button>
                      </InlineStack>
                    </InlineStack>
                    <label htmlFor="rl-code" className="Admin-note">テンプレートのコード（Liquid）</label>
                    <textarea
                      id="rl-code"
                      className="RL-code"
                      spellCheck={false}
                      value={layout.code}
                      maxLength={LAYOUT_LIMITS.maxCodeLength}
                      onChange={(e) => update({ ...layout, code: e.target.value })}
                      onKeyDown={onCodeKey}
                    />
                  </>
                )}
                <details className="RL-vars">
                  <summary>使える値（変数）</summary>
                  <Box paddingBlockStart="200">
                    <BlockStack gap="100">
                      {TEMPLATE_VARIABLES[kind].map((v) => (
                        <div key={v.name}>
                          <code>{`{{ ${v.name} }}`}</code> {v.label}
                        </div>
                      ))}
                      <div>
                        フィルター: <code>{"| money"}</code>（¥1,234）、<code>{"| number"}</code>（1,234）、<code>{"| qrcode | raw"}</code>（QR コード）、<code>{"| business_day_label: 4, \"2026-01-01,2026-01-12\""}</code>（土日と休みを除いた 4 営業日後）、ほか Liquid の標準のフィルター。値は自動で HTML エスケープされます。<code>{"| raw"}</code> はそのまま出すので、お客様が入れた値（メモ・宛名・属性）には使わないでください。
                      </div>
                    </BlockStack>
                  </Box>
                </details>
              </BlockStack>
            </Card>
          ) : null}
        </BlockStack>

        <div className="RL-preview" id="rl-preview" aria-label="プレビュー">
          <Text as="p" tone="subdued">{`プレビュー（見本のデータ・${layout.paperWidthMm}mm）`}</Text>
          {rendered.ok ? null : (
            <div role="alert" style={{ color: "#8e1f0b", maxWidth: paperWidthPx(layout.paperWidthMm) }}>
              {rendered.error}
            </div>
          )}
          <Preview html={rendered.html} widthPx={paperWidthPx(layout.paperWidthMm)} />
        </div>
      </div>
    </div>
  );
}
