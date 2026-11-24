declare module 'qrcode' {
	interface QrCodeOptions {
		width?: number;
		margin?: number;
		errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
	}
	const QRCode: {
		toDataURL(value: string, options?: QrCodeOptions): Promise<string>;
	};
	export default QRCode;
}
