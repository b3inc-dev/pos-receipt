/**
 * 会員番号を CODE128 バーコードで表示するコンポーネント。
 * 管理画面の会員証説明ページなどで利用。
 */
import { useEffect, useRef } from "react";
import JsBarcode from "jsbarcode";

interface MemberBarcodeProps {
  /** 表示する会員番号（バーコードの値） */
  value: string;
  /** バーコードの幅（細線の幅） */
  width?: number;
  /** バーコードの高さ（px） */
  height?: number;
  /** 会員番号テキストを表示するか */
  displayValue?: boolean;
  className?: string;
}

export function MemberBarcode({
  value,
  width = 2,
  height = 80,
  displayValue = true,
  className,
}: MemberBarcodeProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!value || !svgRef.current) return;
    try {
      JsBarcode(svgRef.current, value, {
        format: "CODE128",
        width,
        height,
        displayValue,
      });
    } catch (e) {
      console.error("JsBarcode error:", e);
    }
  }, [value, width, height, displayValue]);

  if (!value) return null;
  return <svg ref={svgRef} className={className} />;
}
