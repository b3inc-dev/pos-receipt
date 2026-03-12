/**
 * App Proxy 経由で公開される LIFF 会員証ページ（GET のみ）。
 * カスタムアプリ（APP_DISTRIBUTION=inhouse）でのみ有効。公開アプリでは 404 を返す。
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { isInhouseMode } from "../utils/planFeatures.server";

const LIFF_SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";
const JSBARCODE_CDN =
  "https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.3/JsBarcode.all.min.js";

const LOGO_SVG =
  '<svg class="plastic-card-logo plastic-card-logo--svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1217.51 450" aria-hidden="true">' +
  '<path class="cls-1" d="M418.92,444.15v-4.68l6.56-1.87c6.24-1.87,10.54-4.69,12.88-8.43,2.34-3.75,3.51-8.74,3.51-14.99v-146.63c0-6.56-1.17-11.48-3.51-14.76-2.34-3.28-6.64-5.54-12.88-6.79l-6.56-1.41v-4.68l85.73-27.64,4.68,4.68-1.41,66.52v131.17c0,6.25,1.17,11.24,3.51,14.99,2.34,3.75,6.48,6.56,12.41,8.43l4.68,1.41v4.68h-109.62Z"/>' +
  '<path class="cls-1" d="M807.28,444.15v-4.69l6.56-1.87c6.24-1.87,10.54-4.69,12.88-8.43,2.34-3.75,3.51-8.74,3.51-14.99v-146.63c0-6.56-1.17-11.48-3.51-14.76-2.34-3.28-6.64-5.54-12.88-6.79l-6.56-1.41v-4.68l85.73-27.64,4.68,4.68-1.41,66.52v131.17c0,6.25,1.17,11.24,3.51,14.99,2.34,3.75,6.48,6.56,12.41,8.43l4.68,1.41v4.69h-109.62Z"/>' +
  '<path class="cls-1" d="M944.82,281.56c-7.93,0-14.63-2.65-20.1-7.96-5.48-5.31-8.21-12.03-8.21-20.18s2.74-15.18,8.21-20.36c5.47-5.18,12.17-7.78,20.1-7.78s14.56,2.59,19.92,7.78c5.36,5.18,8.04,11.98,8.04,20.36s-2.68,14.87-8.04,20.18c-5.36,5.31-12.01,7.96-19.92,7.96Z"/>' +
  '<path class="cls-1" d="M473.91,185.27c-7.92,0-14.63-2.65-20.1-7.96-5.48-5.31-8.21-12.03-8.21-20.18s2.74-15.18,8.21-20.36c5.47-5.18,12.17-7.77,20.1-7.77s14.56,2.59,19.92,7.77c5.36,5.18,8.04,11.98,8.04,20.36,0,8.15-2.68,14.87-8.04,20.18-5.36,5.31-12.01,7.96-19.92,7.96Z"/>' +
  '<path class="cls-1" d="M1213.29,416.05h-10.31c-13.12,0-19.68-7.03-19.68-21.08v-103.53c0-30.6-7.58-52.7-22.72-66.29-15.15-13.59-36.62-20.38-64.41-20.38-17.18,0-33.11,2.19-47.78,6.56-14.68,4.38-26.47,10.94-35.37,19.68-1.65,1.62-3.09,3.33-4.43,5.09,0,0-.46.77-.49.81-3.06,4.48-4.59,9.86-4.59,16.13,0,8.15,2.74,14.87,8.21,20.18,5.47,5.31,12.17,7.96,20.1,7.96s14.56-2.65,19.93-7.96c4.51-4.47,7.1-9.96,7.81-16.45.18-2.62.02-4.05.05-7.19.02-2.54.07-4.96.07-6.51,0-16.33,13.17-29.57,29.41-29.57s29.42,13.24,29.42,29.57c0,8.71.14,66.17.14,66.17-6.87,1.25-13.43,2.42-19.68,3.51-6.25,1.1-11.87,2.11-16.86,3.05-32.17,6.25-55.75,15.54-70.74,27.87-14.99,12.34-22.49,25.85-22.49,40.52,0,19.37,6.16,34.2,18.5,44.5,12.33,10.31,27.56,15.46,45.68,15.46,15.61,0,28.34-3.51,38.18-10.54,9.84-7.03,19.44-15.53,28.81-25.53,2.5,10.62,7.73,19.13,15.69,25.53,7.96,6.4,18.81,9.6,32.56,9.6,12.8,0,22.72-2.03,29.75-6.09,7.03-4.06,13.5-9.84,19.44-17.33l-4.22-3.75ZM1118.66,397.31c-7.49,6.25-13.98,10.85-19.44,13.82-5.47,2.97-11.32,4.45-17.57,4.45-8.43,0-15.62-3.2-21.55-9.6-5.94-6.4-8.9-16-8.9-28.81,0-14.99,4.29-26.94,12.88-35.84,8.59-8.9,20.06-15.23,34.43-18.97,4.33-.99,7.65-1.69,10.74-2.17,3.15-.49,6.31-1.09,9.4-1.58v78.7Z"/>' +
  '<path class="cls-1" d="M781.86,416.05h-10.31c-13.12,0-19.68-7.03-19.68-21.08v-103.53c0-30.6-7.58-52.7-22.72-66.29-15.15-13.59-36.62-20.38-64.41-20.38-17.18,0-33.11,2.19-47.78,6.56-14.68,4.38-26.47,10.94-35.37,19.68-1.65,1.62-3.09,3.33-4.43,5.09,0,0-.46.77-.49.81-3.06,4.48-4.59,9.86-4.59,16.13,0,8.15,2.74,14.87,8.21,20.18,5.47,5.31,12.17,7.96,20.1,7.96s14.56-2.65,19.93-7.96c4.51-4.47,7.1-9.96,7.81-16.45.18-2.62.02-4.05.05-7.19.02-2.54.07-4.96.07-6.51,0-16.33,13.17-29.57,29.41-29.57s29.42,13.24,29.42,29.57c0,8.71.14,66.17.14,66.17-6.87,1.25-13.43,2.42-19.68,3.51-6.25,1.1-11.87,2.11-16.86,3.05-32.17,6.25-55.75,15.54-70.74,27.87-14.99,12.34-22.49,25.85-22.49,40.52,0,19.37,6.16,34.2,18.5,44.5,12.33,10.31,27.56,15.46,45.67,15.46,15.61,0,28.34-3.51,38.18-10.54,9.84-7.03,19.44-15.53,28.81-25.53,2.5,10.62,7.73,19.13,15.69,25.53,7.96,6.4,18.81,9.6,32.56,9.6,12.8,0,22.72-2.03,29.75-6.09,7.03-4.06,13.5-9.84,19.44-17.33l-4.22-3.75ZM687.23,397.31c-7.5,6.25-13.98,10.85-19.44,13.82-5.47,2.97-11.32,4.45-17.57,4.45-8.43,0-15.62-3.2-21.55-9.6-5.94-6.4-8.9-16-8.9-28.81,0-14.99,4.29-26.94,12.88-35.84,8.59-8.9,20.06-15.22,34.43-18.97,4.33-.99,7.65-1.69,10.74-2.17,3.15-.49,6.31-1.08,9.4-1.58v78.7Z"/>' +
  '<path class="cls-1" d="M249.83,426.26c-1.18,0-2.34-.08-3.51-.11-.12,0-.23,0-.35,0-1.52,0-3.02-.07-4.53-.14l-.82-.04c-2.49-.1-6.28-.47-6.31-.47-32.35-3.27-61.79-20.18-85.24-46.21-34.36-36.92-56.22-92.33-56.22-154.3,0-55.86,17.76-106.39,46.43-142.86,24.9-32.73,57.4-53.01,92.27-57.39.56-.07,1.13-.12,1.7-.17l1.07-.1c4.33-.44,8.14-.65,11.65-.65.18,0,.36.01.54.02,1.11-.03,2.21-.11,3.33-.11,50.19,0,94.84,30.23,123.58,77.22h4.1v-52.5s-2.81-2.15-2.81-2.15c-20.36-15.57-42.85-27.32-66.84-34.92C271.6-.08,233.28-2.99,194.73,3.13c-15.37,2.3-30.57,6.2-45.14,11.58-.35.13-.71.24-1.06.36-.48.16-.96.32-1.44.5-1.4.52-2.76,1.07-4.12,1.63l-1.94.78c-29.76,11.86-55.24,28.15-75.71,48.44-21.95,21.76-38.56,46.38-49.36,73.18C5.17,166.39-.2,194.84,0,224.17c.2,29.34,5.97,57.88,17.15,84.82,11.18,26.97,28.28,51.88,50.81,74.01,11.42,11.22,24.6,21.44,39.07,30.29,27.91,18.47,59.52,30.05,93.89,34.39,10.38,1.54,20.54,2.32,30.21,2.32,25.21,0,50.07-4.56,73.89-13.57,23.68-8.96,47.13-22.34,69.7-39.77l2.79-2.15v-45.81s-3.89,0-3.89,0c-28.73,47.18-73.48,77.56-123.78,77.56Z"/>' +
  '</svg>';

function buildHtml(liffId: string, apiBase: string, shop: string): string {
  const escapedShop = shop
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ");
  const escapedApiBase = apiBase
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ");
  const logoJson = JSON.stringify(LOGO_SVG);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <title>会員証</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", sans-serif;
      background: #f4f5f7;
      color: #202223;
      min-height: 100vh;
    }
    .container { max-width: 100%; margin: 0 auto; }
    .loading {
      text-align: center;
      padding: 56px 20px;
      color: #6d7175;
      font-size: 15px;
    }
    .loading::before {
      content: "";
      display: block;
      width: 32px;
      height: 32px;
      margin: 0 auto 16px;
      border: 3px solid #e1e3e5;
      border-top-color: #5c5f62;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error {
      background: #fff4e5;
      border: 1px solid #e0b252;
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 16px;
      color: #202223;
      font-size: 14px;
      line-height: 1.5;
    }
    .member-card-section {
      max-width: 360px;
      margin: 0 auto 24px;
    }
    .member-card-section .plastic-card {
      position: relative;
      isolation: isolate;
      width: 100%;
      max-width: 100%;
      margin: 0 auto 16px;
      aspect-ratio: 1.586;
      border-radius: 16px;
      box-shadow: 0 10px 24px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(0,0,0,0.08);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: #e3c8aa;
    }
    .member-card-section .plastic-card::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 16px;
      pointer-events: none;
      z-index: 1;
      background: linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 18%, rgba(255,255,255,0.00) 40%, rgba(255,255,255,0.04) 62%, rgba(255,255,255,0.01) 100%);
      mix-blend-mode: normal;
    }
    .member-card-section .plastic-card::after {
      content: none;
    }
    .member-card-section .plastic-card-top,
    .member-card-section .plastic-card-bottom { position: relative; z-index: 2; }
    .member-card-section .plastic-card--diamond {
      background: radial-gradient(circle at 18% 18%, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.015) 18%, transparent 34%), radial-gradient(circle at 78% 24%, rgba(214,236,255,0.08) 0%, rgba(214,236,255,0.012) 16%, transparent 28%), radial-gradient(circle at 84% 78%, rgba(238,233,255,0.06) 0%, rgba(238,233,255,0.01) 18%, transparent 30%), linear-gradient(135deg, #111315 0%, #1b1f24 18%, #2b3138 36%, #161a1f 54%, #242b33 72%, #0d0f12 100%);
    }
    .member-card-section .plastic-card--platinum {
      background: radial-gradient(circle at 18% 18%, rgba(255,255,255,0.36) 0%, rgba(255,255,255,0.08) 20%, transparent 40%), radial-gradient(circle at 82% 78%, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.02) 18%, transparent 32%), linear-gradient(135deg, #9299a4 0%, #e9edf2 16%, #d2d7df 34%, #fbfcfd 52%, #dce0e7 72%, #9aa1ac 100%);
    }
    .member-card-section .plastic-card--gold {
      background: radial-gradient(circle at 18% 20%, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.05) 22%, transparent 40%), radial-gradient(circle at 84% 78%, rgba(255,248,210,0.10) 0%, rgba(255,248,210,0.02) 18%, transparent 32%), linear-gradient(135deg, #9b6a00 0%, #e2bb38 18%, #f1d67e 42%, #d3a537 68%, #8a5e00 100%);
    }
    .member-card-section .plastic-card--silver {
      background: radial-gradient(circle at 18% 20%, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0.06) 22%, transparent 40%), radial-gradient(circle at 84% 78%, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 18%, transparent 32%), linear-gradient(135deg, #8e959d 0%, #d9dde1 20%, #c4c9cf 43%, #f0f2f4 68%, #878e97 100%);
    }
    .member-card-section .plastic-card--regular {
      background: radial-gradient(circle at 18% 20%, rgba(255,255,255,0.24) 0%, rgba(255,255,255,0.05) 22%, transparent 42%), linear-gradient(135deg, #d4b08d 0%, #e3c8aa 40%, #d9bb99 100%);
    }
    .member-card-section .plastic-card-top {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px 24px;
      min-height: 0;
    }
    .member-card-section .plastic-card-logo-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 140px;
      max-width: 100%;
    }
    .member-card-section .plastic-card-logo--svg {
      display: block;
      width: 140px;
      max-width: 100%;
      height: auto;
      transition: filter 0.3s ease, transform 0.3s ease;
      animation: memberLogoGlow 1.8s ease-out 0.2s 1 both;
    }
    .member-card-section .plastic-card-logo--svg .cls-1 {
      fill: #ffffff;
      transition: fill 0.3s ease, filter 0.3s ease;
    }
    .member-card-section .plastic-card--diamond .plastic-card-logo--svg {
      filter: drop-shadow(0 1px 0 rgba(255,255,255,0.28)) drop-shadow(0 0 4px rgba(255,255,255,0.08)) drop-shadow(0 0 8px rgba(210,228,245,0.08));
    }
    .member-card-section .plastic-card--diamond .plastic-card-logo--svg .cls-1 { fill: #5b6673; }
    .member-card-section .plastic-card--diamond .barcode-id-block {
      background: radial-gradient(circle at 16% 18%, rgba(255,255,255,0.94) 0%, rgba(242,250,255,0.82) 20%, rgba(223,242,255,0.74) 38%, rgba(238,230,255,0.72) 58%, rgba(255,255,255,0.80) 100%), radial-gradient(circle at 82% 22%, rgba(184,232,255,0.58) 0%, rgba(184,232,255,0.20) 22%, transparent 40%), radial-gradient(circle at 78% 82%, rgba(232,216,255,0.46) 0%, rgba(232,216,255,0.14) 22%, transparent 40%), linear-gradient(135deg, rgba(237,247,255,0.99) 0%, rgba(214,235,255,0.98) 26%, rgba(247,246,255,0.99) 52%, rgba(222,239,255,0.98) 76%, rgba(248,246,255,0.99) 100%);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.78), inset 0 -1px 0 rgba(210,227,247,0.30), 0 -1px 0 rgba(0,0,0,0.03);
    }
    .member-card-section .plastic-card--platinum .plastic-card-logo--svg {
      filter: drop-shadow(0 1px 0 rgba(255,255,255,0.55)) drop-shadow(0 0 6px rgba(255,255,255,0.18));
    }
    .member-card-section .plastic-card--platinum .plastic-card-logo--svg .cls-1 { fill: #3b4450; }
    .member-card-section .plastic-card--gold .plastic-card-logo--svg {
      filter: drop-shadow(0 0 3px rgba(255,220,90,0.88)) drop-shadow(0 0 10px rgba(255,215,0,0.55)) drop-shadow(0 1px 0 rgba(255,248,196,0.96));
    }
    .member-card-section .plastic-card--gold .plastic-card-logo--svg .cls-1 { fill: #fff2b8; }
    .member-card-section .plastic-card--silver .plastic-card-logo--svg {
      filter: drop-shadow(0 0 3px rgba(230,233,238,0.88)) drop-shadow(0 0 8px rgba(192,192,192,0.52)) drop-shadow(0 1px 0 rgba(255,255,255,0.94));
    }
    .member-card-section .plastic-card--silver .plastic-card-logo--svg .cls-1 { fill: #fcfdff; }
    .member-card-section .plastic-card--regular .plastic-card-logo--svg {
      filter: drop-shadow(0 0 2px rgba(255,255,255,0.35)) drop-shadow(0 1px 0 rgba(255,255,255,0.65));
    }
    .member-card-section .plastic-card--regular .plastic-card-logo--svg .cls-1 { fill: #ffffff; }
    .member-card-section .plastic-card-bottom {
      padding: 0 16px 0;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-end;
    }
    .member-card-section .barcode-id-block {
      background: rgba(255,255,255,0.96);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      border-radius: 0;
      padding: 10px 10px 8px;
      margin: 0;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 -1px 0 rgba(0,0,0,0.04);
    }
    .member-card-section .barcode-wrap {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      margin: 0;
    }
    .member-card-section .plastic-card .barcode-id-block .barcode-wrap svg {
      width: 100%;
      height: 80px;
      max-width: 100%;
    }
    .member-card-section .member-id-on-card {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.08em;
      color: #202223;
      text-align: center;
    }
    .member-card-section .card-bottom-spacer {
      height: 14px;
      margin: 0 -1px 0 0;
      background: rgba(255,255,255,0.10);
    }
    .member-card-section .hint-below-card {
      font-size: 13px;
      color: #6d7175;
      text-align: center;
      margin: 0 0 20px;
      line-height: 1.6;
    }
    .member-card-section .section-bordered {
      border-top: 1px solid #e1e3e5;
      border-bottom: 1px solid #e1e3e5;
      padding: 14px 0;
      margin-bottom: 16px;
      font-size: 14px;
      color: #202223;
      text-align: center;
    }
    .rank-row { margin-bottom: 12px; font-size: 14px; text-align: center; }
    .rank-row .label { color: #6d7175; }
    .rank-row .value { font-weight: 600; color: #202223; }
    .points-row { margin-top: 4px; text-align: center; }
    .points-value { font-size: 28px; font-weight: 700; color: #202223; letter-spacing: 0.02em; }
    .points-unit { font-size: 14px; color: #6d7175; margin-left: 4px; }
    @keyframes memberCardShine {
      0% { left: -52%; opacity: 0; }
      12% { opacity: 0.35; }
      35% { opacity: 0.95; }
      68% { opacity: 0.55; }
      100% { left: 118%; opacity: 0; }
    }
    @keyframes memberLogoGlow {
      0% { transform: scale(0.985); opacity: 0.92; }
      35% { transform: scale(1.018); opacity: 1; }
      100% { transform: scale(1); opacity: 1; }
    }
    @media screen and (max-width: 480px) {
      .member-card-section .plastic-card-top { padding: 18px 18px; }
      .member-card-section .plastic-card-logo-wrap { width: 124px; }
      .member-card-section .plastic-card-logo--svg { width: 124px; }
      .member-card-section .plastic-card .barcode-id-block .barcode-wrap svg { height: 72px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .member-card-section .plastic-card::after,
      .member-card-section .plastic-card-logo--svg { animation: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div id="root">
      <div class="loading">読み込み中…</div>
    </div>
  </div>
  <script src="${LIFF_SDK_URL}"></script>
  <script src="${JSBARCODE_CDN}"></script>
  <script>
(function() {
  var LIFF_ID = '${liffId}';
  var API_BASE = '${escapedApiBase}';
  var SHOP = '${escapedShop}';
  var LOGO_SVG = ${logoJson};

  var root = document.getElementById('root');

  var isDebug = typeof location !== 'undefined' && location.search.indexOf('debug=1') !== -1;

  function esc(s) {
    if (s == null || s === '') return '';
    return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function showError(msg, detail) {
    var html = '<div class="error">' + esc(msg) + '</div>';
    if (detail && isDebug) {
      html += '<div class="error" style="margin-top:8px;font-size:12px;word-break:break-all;">' + esc(detail) + '</div>';
    }
    root.innerHTML = html;
  }

  function formatPoints(val) {
    if (val == null || val === '') return '';
    var str = String(val).replace(/[^0-9-]/g, '');
    var n = parseInt(str, 10);
    if (isNaN(n)) return String(val);
    return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  }
  function getRankClass(rankName) {
    if (!rankName || typeof rankName !== 'string') return '';
    var r = rankName.trim();
    if (r.indexOf('ダイヤモンド') !== -1) return 'diamond';
    if (r.indexOf('プラチナ') !== -1) return 'platinum';
    if (r.indexOf('ゴールド') !== -1) return 'gold';
    if (r.indexOf('シルバー') !== -1) return 'silver';
    if (r.indexOf('レギュラー') !== -1 || r.indexOf('白') !== -1) return 'regular';
    return '';
  }
  /** 次のランクまでの閾値（円）。テーマの会員証と同一 */
  function getNextRankThreshold(rankName) {
    if (!rankName || typeof rankName !== 'string') return null;
    var r = rankName.trim();
    if (r.indexOf('ダイヤモンド') !== -1 || r === 'VIP') return null;
    if (r.indexOf('レギュラー') !== -1 || r.indexOf('白') !== -1) return 15000;
    if (r.indexOf('シルバー') !== -1) return 30000;
    if (r.indexOf('ゴールド') !== -1) return 50000;
    if (r.indexOf('プラチナ') !== -1) return 100000;
    return null;
  }
  function formatYen(num) {
    if (num == null || isNaN(num)) return '';
    var n = Math.floor(Number(num));
    return '¥' + String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  }
  function showMember(data) {
    var memberId = data.memberId || '';
    var rankName = data.rankName != null ? data.rankName : '';
    var pointsApproved = data.pointsApproved != null ? data.pointsApproved : '';
    var rankDecisionPurchasePrice = data.rankDecisionPurchasePrice != null ? Number(data.rankDecisionPurchasePrice) : NaN;
    var safeId = esc(memberId);
    var safeRank = esc(rankName);
    var pointsDisplay = formatPoints(pointsApproved);
    var rankClass = getRankClass(rankName);
    var cardClass = 'plastic-card' + (rankClass ? ' plastic-card--' + rankClass : '');
    var nextRankHtml = '';
    var threshold = getNextRankThreshold(rankName);
    if (threshold != null && !isNaN(rankDecisionPurchasePrice)) {
      var remaining = Math.max(0, threshold - rankDecisionPurchasePrice);
      if (remaining > 0) {
        nextRankHtml = '<div class="rank-row"><span class="label">ランクアップまで残り：</span><span class="value">' + esc(formatYen(remaining)) + '</span></div>';
      }
    }
    var sectionHtml = '<div class="member-card-section">' +
      '<div class="' + cardClass + '">' +
        '<div class="plastic-card-top"><div class="plastic-card-logo-wrap">' + LOGO_SVG + '</div></div>' +
        '<div class="plastic-card-bottom">' +
          '<div class="barcode-id-block">' +
            '<div class="barcode-wrap"><svg id="barcode-wrap"></svg></div>' +
            '<div class="member-id-on-card">' + safeId + '</div>' +
          '</div>' +
          '<div class="card-bottom-spacer"></div>' +
        '</div>' +
      '</div>' +
      '<p class="hint-below-card">お会計の際にこの画面のバーコードを提示してください。</p>' +
      '<div class="section-bordered">会員ID：' + safeId + '</div>' +
      '<div class="rank-row"><span class="label">現在のランク：</span>' + (safeRank || '—') + '</div>' +
      nextRankHtml +
      '<div class="points-row"><span class="points-value">' + (pointsDisplay ? esc(pointsDisplay) : '0') + '</span><span class="points-unit">ポイント</span></div>' +
      '</div>';
    root.innerHTML = sectionHtml;
    var wrap = document.getElementById('barcode-wrap');
    if (wrap) {
      try {
        JsBarcode(wrap, String(memberId).trim(), { format: 'CODE128', width: 2, height: 45, displayValue: false });
      } catch (e) {
        var cardBottom = root.querySelector('.plastic-card-bottom');
        if (cardBottom) cardBottom.innerHTML = '<div class="barcode-id-block"><p class="error">バーコードの表示に失敗しました</p><div class="member-id-on-card">' + safeId + '</div></div><div class="card-bottom-spacer"></div>';
      }
    }
  }

  var messages = {
    LIFF_INIT_FAILED: 'LIFFの初期化に失敗しました（LIFF ID・Endpoint URLを確認）',
    ID_TOKEN_FAILED: 'IDトークンの取得に失敗しました',
    LINE_AUTH_FAILED: 'LINE認証に失敗しました',
    ID_TOKEN_EXPIRED: 'トークンの有効期限が切れました。ページを再読み込みするか、LINEアプリから開き直してください。',
    CUSTOMER_NOT_LINKED: 'LINE連携済み会員が見つかりません',
    MEMBER_ID_NOT_SET: '会員番号が設定されていません',
    SYSTEM_ERROR: 'システムエラーが発生しました'
  };

  function run() {
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    var tokenPromise = liff.getIDToken();
    if (tokenPromise && typeof tokenPromise.then === 'function') {
      tokenPromise.then(sendTokenToApi).catch(function() { showError(messages.ID_TOKEN_FAILED); });
    } else {
      sendTokenToApi(tokenPromise);
    }
  }

  function sendTokenToApi(idToken) {
    if (!idToken) {
      showError(messages.ID_TOKEN_FAILED);
      return;
    }
    fetch(API_BASE + '/api/member-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: idToken, shop: SHOP })
    }).then(function(res) { return res.json(); }).then(function(data) {
      if (data.ok && data.memberId) {
        showMember({
          memberId: data.memberId,
          rankName: data.rankName,
          pointsApproved: data.pointsApproved,
          rankDecisionPurchasePrice: data.rankDecisionPurchasePrice
        });
      } else {
        showError(messages[data.message] || messages.SYSTEM_ERROR);
      }
    }).catch(function() {
      showError(messages.SYSTEM_ERROR);
    });
  }

  liff.init({ liffId: LIFF_ID }).then(run).catch(function(err) {
    var detail = isDebug && err && err.message
      ? 'ページURL: ' + location.href + ' / LIFF ID: ' + LIFF_ID + ' / エラー: ' + err.message
      : (isDebug ? 'ページURL: ' + location.href + ' / LIFF ID: ' + LIFF_ID : null);
    showError(messages.LIFF_INIT_FAILED, detail);
  });
})();
  </script>
</body>
</html>`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isInhouseMode()) {
    return new Response(
      "<!DOCTYPE html><html><head><meta charset='utf-8'/><title>ご利用できません</title></head><body><p>この機能はカスタムアプリでのみご利用いただけます。</p></body></html>",
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const liffId = process.env.LIFF_ID?.trim() ?? "";
  const apiBase = (process.env.SHOPIFY_APP_URL?.trim() ?? "").replace(/\/$/, "");

  if (!liffId || !apiBase) {
    return new Response(
      "<!DOCTYPE html><html><body><p>設定エラー: LIFF_ID または SHOPIFY_APP_URL が未設定です。</p></body></html>",
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const html = buildHtml(liffId, apiBase, shop);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
