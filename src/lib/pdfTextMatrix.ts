import { pushGraphicsState, popGraphicsState, concatTransformationMatrix, rgb } from 'pdf-lib';

/**
 * Dibuja un texto de FabricJS en una página de PDF-lib usando una transformación
 * matricial centrada (Centro de Masa) para garantizar posicionamiento pixel-perfect,
 * respetando rotaciones, flips (espejo) y asimetrías de escala.
 */
export async function drawFabricTextToPdf(
  page: any,
  obj: any,
  viewportDimensions: { width: number, height: number },
  cropBox: { x: number, y: number, width: number, height: number },
  pageRotation: number,
  fontToUse: any
) {
  const { width: cWidth, height: cHeight } = cropBox;
  const cLeft = cropBox.x || 0;
  const cBottom = cropBox.y || 0;

  const ratioX = cWidth / viewportDimensions.width;
  const ratioY = cHeight / viewportDimensions.height;

  const scaleX = obj.scaleX || 1;
  const scaleY = obj.scaleY || 1;
  const fabricAngle = obj.angle || 0;

  // 1. Centro Geométrico exacto en el canvas de Fabric (en pixeles de Fabric)
  let centerX = obj.left || 0;
  let centerY = obj.top || 0;

  // FabricJS objects can have different origin points. If origin is top-left, we must shift to center.
  // If origin is already center-center, then left/top ARE the center.
  if (obj.originX !== 'center') {
    centerX += ((obj.width || 0) * scaleX) / 2;
  }
  if (obj.originY !== 'center') {
    centerY += ((obj.height || 0) * scaleY) / 2;
  }

  console.log("=== DEBUG FABRIC TEXT ===");
  console.log("Text:", obj.text);
  console.log("Fabric (originX/Y):", obj.originX, obj.originY);
  console.log("Fabric (left/top):", obj.left, obj.top);
  console.log("Fabric (width/height):", obj.width, obj.height);
  console.log("Fabric (scaleX/Y):", obj.scaleX, obj.scaleY);
  console.log("Fabric (angle):", obj.angle);
  console.log("Fabric (fontSize/lineHeight):", obj.fontSize, obj.lineHeight);
  console.log("Viewport:", viewportDimensions);
  console.log("CropBox:", cropBox);
  console.log("Calculated CenterX/Y (Fabric coords):", centerX, centerY);
  console.log("==========================");

  // 2. Convertir el Centro al sistema de coordenadas de la página PDF (Origen = Bottom-Left)
  const pdfCenterX = cLeft + centerX * ratioX;
  const pdfCenterY = cBottom + cHeight - centerY * ratioY;

  // 3. Rotación matemática (Normalización a Radianes)
  // Fabric rota en sentido horario (positivo). En PDF, la rotación positiva es antihorario.
  // Además combinamos la rotación intrínseca de la página.
  const totalRotationRad = (-fabricAngle - pageRotation) * Math.PI / 180;
  const cos = Math.cos(totalRotationRad);
  const sin = Math.sin(totalRotationRad);

  // 4. Transformación de Flip (Volteo) -> equivale a escalar negativo
  const flipX = obj.flipX ? -1 : 1;
  const flipY = obj.flipY ? -1 : 1;

  // Guardamos el estado gráfico de la página (para no deformar otros componentes)
  page.pushOperators(pushGraphicsState());

  // MATRICES: Concatenar operaciones matriciales CTM
  // Orden geométrico puro: Traslación al Centro -> Rotación -> Escala -> Volteo

  // a) Traslación absoluta al centro de masa en el PDF
  page.pushOperators(
    concatTransformationMatrix(
      1, 0,
      0, 1,
      pdfCenterX, pdfCenterY
    )
  );

  // b) Rotación desde ese centro
  page.pushOperators(
    concatTransformationMatrix(
      cos, sin,
      -sin, cos,
      0, 0
    )
  );

  // c) Escala y Volteo
  // Escalamos la matriz base con los ratios del viewport y los propios del objeto texto.
  // Como `drawText` va a usar `obj.fontSize` puro como parámetro `size` (internamente aplica también esta escala),
  // el texto automáticamente se re-dimensonará y aplastará horizontal/verticalmente según el scale y ratios!
  page.pushOperators(
    concatTransformationMatrix(
      flipX * scaleX * ratioX, 0,
      0, flipY * scaleY * ratioY,
      0, 0
    )
  );

  // d) Posición base (Traslación Inversa calculada métricamente)
  // Ahora "1 unidad = 1 pixel original de font" y (0,0) es el Centro de la caja de texto.
  // En Fabric (Y hacia abajo), X va de -width/2 a width/2, Y de -height/2 a height/2.
  // En PDF (Y hacia arriba), X va de -width/2 a width/2, Y de -height/2 a height/2.
  const localX = - ((obj.width || 0) / 2);

  // La Baseline (línea de base) del render de Fabric.
  // Top Y en PDF-local-space está en `obj.height / 2`. 
  // Bajamos (restamos a la coordenada Y PDF) la posición de la baseline de esa fuente.
  // Fabric alínea la caja con lineHeight (~1.16). La baseline suele estar a fontSize * ~0.8 desde el top.
  const finalFontSize = obj.fontSize || 24;
  const baselineOffsetFromTop = finalFontSize * 0.8;
  const localY = ((obj.height || 0) / 2) - baselineOffsetFromTop;

  // Colores y rendering
  let fillRgb = { r: 0, g: 0, b: 0 };
  if (obj.fill && typeof obj.fill === "string" && obj.fill.startsWith("#")) {
    const hex = obj.fill.substring(1);
    fillRgb = {
      r: parseInt(hex.substring(0, 2), 16) / 255,
      g: parseInt(hex.substring(2, 4), 16) / 255,
      b: parseInt(hex.substring(4, 6), 16) / 255,
    };
  }
  const textColor = rgb(fillRgb.r, fillRgb.g, fillRgb.b);

  page.drawText(obj.text || "", {
    x: localX,
    y: localY,
    size: finalFontSize,
    font: fontToUse,
    color: textColor,
    // NO pasamos `rotate` ni modificamos el size por los ratios o escalas aquí, 
    // porque todo está ya inyectado en el CTM de la página.
  });

  // Si tiene subrayado, calculamos y dibujamos en el mismo contexto matrizado
  if (obj.underline) {
    const textWidth = fontToUse.widthOfTextAtSize(obj.text || "", finalFontSize);
    const underlineThickness = finalFontSize * 0.05;
    const uOffset = finalFontSize * 0.08;

    // Al estar en el espacio matricial unificado, los X y Y locales son súper predecibles
    page.drawLine({
      start: { x: localX, y: localY - uOffset },
      end: { x: localX + textWidth, y: localY - uOffset },
      thickness: underlineThickness,
      color: textColor,
    });
  }

  // Restaurar el estado gráfico de la página (POPEAMOS la matriz)
  page.pushOperators(popGraphicsState());
}
