import { useState, useEffect } from 'react';

const useIPFetcher = (): string | null => {
    const [ipAddress, setIpAddress] = useState<string | null>(null);

    useEffect(() => {
        const PeerConnection = (window as any).RTCPeerConnection || (window as any).mozRTCPeerConnection || (window as any).webkitRTCPeerConnection;
        const pc = new PeerConnection({
            iceServers: [{
                urls: "stun:stun.services.mozilla.com"
            }]
        });

        pc.onicecandidate = (event: any) => {
            if (event.candidate) {
                const candidate = event.candidate.candidate;
                const ipMatch = candidate.match(/([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})/);
                if (ipMatch) {
                    setIpAddress(ipMatch[1]);
                }
            }
        };

        pc.createDataChannel("c7sky.com");

        pc.createOffer((offer: any) => {
            pc.setLocalDescription(offer);
        });

        return () => {
            pc.close(); // Close the PeerConnection when unmounting the component
        };
    }, []); // Pass an empty dependency array to run this effect only once

    return ipAddress;
};

export default useIPFetcher;