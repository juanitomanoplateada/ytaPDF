import { pushGraphicsState, popGraphicsState, concatTransformationMatrix, rgb } from 'pdf-lib';

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

  let centerX = obj.left || 0;
  let centerY = obj.top || 0;

  if (obj.originX !== 'center') {
    centerX += ((obj.width || 0) * scaleX) / 2;
  }
  if (obj.originY !== 'center') {
    centerY += ((obj.height || 0) * scaleY) / 2;
  }

  const pdfCenterX = cLeft + centerX * ratioX;
  const pdfCenterY = cBottom + cHeight - centerY * ratioY;

  const totalRotationRad = (-fabricAngle - pageRotation) * Math.PI / 180;
  const cos = Math.cos(totalRotationRad);
  const sin = Math.sin(totalRotationRad);

  const flipX = obj.flipX ? -1 : 1;
  const flipY = obj.flipY ? -1 : 1;

  page.pushOperators(pushGraphicsState());

  page.pushOperators(
    concatTransformationMatrix(
      1, 0,
      0, 1,
      pdfCenterX, pdfCenterY
    )
  );

  page.pushOperators(
    concatTransformationMatrix(
      cos, sin,
      -sin, cos,
      0, 0
    )
  );

  page.pushOperators(
    concatTransformationMatrix(
      flipX * scaleX * ratioX, 0,
      0, flipY * scaleY * ratioY,
      0, 0
    )
  );

  const localX = - ((obj.width || 0) / 2);

  const finalFontSize = obj.fontSize || 24;

  const fontObj = fontToUse.embedder.font;
  const ascent = fontObj.ascent || 800;
  const descent = fontObj.descent || -200;
  const fontBBoxHeight = ascent - descent;
  const actualAscent = (ascent / fontBBoxHeight) * finalFontSize;
  const fabricLineHeight = obj.lineHeight || 1.16;
  const fabricBoxHeight = finalFontSize * fabricLineHeight;

  const topPadding = (fabricBoxHeight - finalFontSize) / 2;
  const baselineOffsetFromTop = actualAscent + topPadding;

  const localY = ((obj.height || 0) / 2) - baselineOffsetFromTop;

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
  });

  if (obj.underline) {
    const textWidth = fontToUse.widthOfTextAtSize(obj.text || "", finalFontSize);
    const underlineThickness = finalFontSize * 0.05;
    const uOffset = finalFontSize * 0.08;

    page.drawLine({
      start: { x: localX, y: localY - uOffset },
      end: { x: localX + textWidth, y: localY - uOffset },
      thickness: underlineThickness,
      color: textColor,
    });
  }

  page.pushOperators(popGraphicsState());
}

export async function drawFabricImageToPdf(
  page: any,
  obj: any,
  viewportDimensions: { width: number, height: number },
  cropBox: { x: number, y: number, width: number, height: number },
  pageRotation: number,
  imgToDraw: any
) {
  const { width: cWidth, height: cHeight } = cropBox;
  const cLeft = cropBox.x || 0;
  const cBottom = cropBox.y || 0;

  const ratioX = cWidth / viewportDimensions.width;
  const ratioY = cHeight / viewportDimensions.height;

  const scaleX = obj.scaleX || 1;
  const scaleY = obj.scaleY || 1;
  const fabricAngle = obj.angle || 0;

  let centerX = obj.left || 0;
  let centerY = obj.top || 0;

  if (obj.originX !== 'center') {
    centerX += ((obj.width || 0) * scaleX) / 2;
  }
  if (obj.originY !== 'center') {
    centerY += ((obj.height || 0) * scaleY) / 2;
  }

  const pdfCenterX = cLeft + centerX * ratioX;
  const pdfCenterY = cBottom + cHeight - centerY * ratioY;

  const totalRotationRad = (-fabricAngle - pageRotation) * Math.PI / 180;
  const cos = Math.cos(totalRotationRad);
  const sin = Math.sin(totalRotationRad);

  const flipX = obj.flipX ? -1 : 1;
  const flipY = obj.flipY ? -1 : 1;

  page.pushOperators(pushGraphicsState());
  page.pushOperators(
    concatTransformationMatrix(
      1, 0,
      0, 1,
      pdfCenterX, pdfCenterY
    )
  );

  page.pushOperators(
    concatTransformationMatrix(
      cos, sin,
      -sin, cos,
      0, 0
    )
  );

  page.pushOperators(
    concatTransformationMatrix(
      flipX * scaleX * ratioX, 0,
      0, flipY * scaleY * ratioY,
      0, 0
    )
  );

  const localX = - ((obj.width || 0) / 2);
  const localY = - ((obj.height || 0) / 2);

  page.drawImage(imgToDraw, {
    x: localX,
    y: localY,
    width: obj.width || 0,
    height: obj.height || 0,
  });

  page.pushOperators(popGraphicsState());
}
