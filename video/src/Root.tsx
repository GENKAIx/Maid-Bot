import React from "react";
import { Composition } from "remotion";
import { Promo, TOTAL } from "./Promo";
import { Trailer, TRAILER_TOTAL } from "./Trailer";

export const RemotionRoot: React.FC = () => (
  <>
  <Composition id="MaidTrailer" component={Trailer} durationInFrames={TRAILER_TOTAL} fps={30} width={1920} height={1080} />
  <Composition id="MaidPromo" component={Promo} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
  </>
);
