import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ModalPopupComponent } from '../../../../components/modal-popup/modal-popup.component';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { catchError, of } from 'rxjs';

@Component({
  selector: 'app-item',
  standalone: true,
  imports: [ModalPopupComponent, CommonModule, FormsModule],
  templateUrl: './item.component.html',
  styleUrls: ['./item.component.scss'],
  providers: [DatePipe]
})
export class ItemComponent {
  @Input() item: any;
  @Input() onClickEnabled: boolean = false;

  modalVisible = { hash: '', value: false }
  edit = false;
  successMessage: string | null = null;
  errorMessage: string | null = null;
  itemDeleted: boolean = false;
  clicked: boolean = false;

  @Output() cloneItem = new EventEmitter<any>();
  @Output() onSelectItem = new EventEmitter<any>();


  constructor(private http: HttpClient) { }

  onClone() {
    this.toggleModal();
    // Create a clone of the item and add the 'cacheBrust' property
    let clone = { ...this.item, cacheBrust: Date.now() };

    // Emit the cloned item
    this.cloneItem.emit(clone);
  }

  getItemStock(item: any) {
    return item.stock - (item.sold ? item.sold : 0);
  }


  getRandomImage(i: any) {
    const images = [
      'items/dmy3.png',
      'items/dmy4.png',
      'items/dmy5.png'
    ];

    return images[Math.floor(i + 32 / images.length) % images.length];
  }

  toggleModal() {
    if (this.onClickEnabled) {
      if (!((((this.item.stock || 0) - (this.item.sold || 0)) || 0) < 0)) {
        this.clicked = true;
        this.onSelectItem.emit(this.item);
      }
    } else {
      this.modalVisible = {
        hash: Date.now().toString(),
        value: this.modalVisible.value ? false : true
      };
    }
  }

  toggleEdit() {
    this.edit = !this.edit;
    this.successMessage = null;
    this.errorMessage = null;
  }

  deleteItem() {
    const deleteUrl = `/delete/inventory_items/${this.item.id}`;
    this.http.delete(deleteUrl).subscribe({
      next: (response: any) => {
        // Optionally provide feedback to the user, like closing the modal or showing a notification
        this.modalVisible = { hash: '', value: false }
        // You can also reset the form or the `item` object if necessary
        this.item = {
          name: '',
          stock: '',
          min_stock: '',
          buy_price: '',
          sale_price: '',
          barcode: ''
        };
      },
      error: (error: any) => {
        console.error('Error deleting item', error);
        // Optionally handle errors, e.g., show an error message to the user
      }
    });
    this.itemDeleted = true;
  }

  saveItem() {
    if (!this.item.name || !this.item.stock || !this.item.buy_price || !this.item.sale_price) {
      this.errorMessage = 'Please fill in all required fields.';
      return;
    }

    const editUrl = `/update/inventory_items/${this.item.id}`;

    this.http.put(editUrl, this.item)
      .pipe(
        catchError((error) => {
          this.errorMessage = 'Failed to save item. Please try again later.';
          console.error('Error saving item:', error);
          return of(null);
        })
      )
      .subscribe(response => {
        if (response) {
          this.successMessage = 'Item saved successfully!';
          this.edit = false; // Exit edit mode after saving
          this.errorMessage = null;
        }
      });
  }

  getAdditionalFields(item: any): string[] {
    const knownFields = ['name', 'stock', 'min_stock', 'buy_price', 'sale_price', 'barcode', 'created', 'last_updated'];

    return Object.keys(item).filter(key => !knownFields.includes(key)); // Return any keys that aren't in the known fields
  }

}
