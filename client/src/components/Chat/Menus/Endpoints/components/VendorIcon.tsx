import { memo } from 'react';
import { ProviderIcon } from '@librechat/client';
import { getVendor } from 'librechat-data-provider';
import type { VendorId } from 'librechat-data-provider';

/** Fork: a vendor's mark from the provider icon registry; nothing for `other`. */
function VendorIcon({ vendor }: { vendor: VendorId }) {
  const icon = getVendor(vendor).icon;
  if (!icon) {
    return null;
  }
  return (
    <ProviderIcon
      provider={icon.provider}
      model={icon.model}
      size={20}
      className="icon-md shrink-0"
    />
  );
}

export default memo(VendorIcon);
